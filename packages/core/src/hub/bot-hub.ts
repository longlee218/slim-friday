import { CORE_DEFAULTS, type CoreLimits } from "../config-defaults";
import type { Bot, BotId } from "../domain/bot";
import type { Conversation, ConversationId } from "../domain/conversation";
import type { Attachment, Author } from "../domain/message";
import type { BlockReason, WakeIntent, WakeRow } from "../domain/wake";
import type { PermissionGate } from "../permission/permission-gate";
import type { AgentRuntime } from "../ports/agent-runtime";
import type { Clock } from "../ports/clock";
import type { Log } from "../ports/log";
import type { Memory } from "../ports/memory";
import type { BotMessenger, SendRequest, SendResult } from "../ports/messenger";
import type { Store } from "../ports/store";
import type { InboundMessage, Surface } from "../ports/surface";
import { clampBotMessage, nextHop } from "../routing/bot-messages";
import { ChainGuard } from "../routing/chain-guard";
import { routeMessage } from "../routing/route-message";
import { dayOf, pumpEvents } from "./event-pump";
import { changedGroupMemory } from "./group-memory";
import { type PoolEntry, type QueuedWake, SessionPool } from "./session-pool";
import { WakeLog } from "./wake-log";

/** Text of an error value. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What became of a request to wake a bot. */
type WakeOutcome = { ok: true; wakeId: string } | { ok: false; reason: BlockReason | "gone" };

/** Optional parts of a wake. */
interface WakeOpts {
  intent?: WakeIntent;
  handoff?: boolean;
  attachments?: Attachment[];
  /** Chain and parent of a bot-to-bot message (a user message starts its own chain). */
  chainId?: string;
  parentWakeId?: string;
  /** Check the hop cap as if at the last allowed hop (a result going back to the bot that gave the work). */
  exemptFromHops?: boolean;
}

/** What /status shows for one running bot. */
export interface BotStatus {
  botId: BotId;
  sessionId: string;
  busy: boolean;
  tasks: { taskId: string; description: string }[];
}

export interface BotHubDeps {
  runtime: AgentRuntime;
  surface: Surface;
  store: Store;
  clock: Clock;
  gate: PermissionGate;
  limits?: CoreLimits;
  /** Bot and group memory; without it no memory reaches the prompt. */
  memory?: Memory;
  /** Where wake events and failures are reported; without it nothing is logged. */
  log?: Log;
}

/**
 * Drives the bots: routes each user message to the right bots, keeps one session per active bot,
 * carries a bot's `SendToBot` / `HandOff` to its target, and applies the loop, rate and spend caps.
 */
export class BotHub implements BotMessenger {
  private pool: SessionPool;
  private guard: ChainGuard;
  private limits: CoreLimits;
  private wakeLog: WakeLog;
  /** Caps already announced; cleared when the user writes again in that conversation. */
  private noticed = new Set<string>();

  constructor(private deps: BotHubDeps) {
    this.limits = deps.limits ?? CORE_DEFAULTS;
    this.pool = new SessionPool(deps.runtime, deps.store, deps.clock, deps.gate, deps.memory);
    this.guard = new ChainGuard(deps.clock, this.limits);
    this.wakeLog = new WakeLog(deps.store, deps.clock, deps.log);
  }

  /** Start listening to the surface. */
  start(): void {
    this.deps.surface.onMessage((m) => {
      this.handle(m).catch(async (err) => {
        // Never lose a failure: tell the user where it happened.
        const why = err instanceof Error ? err.message : String(err);
        this.deps.log?.error({ error: why, conversationId: m.conversationId }, "hub.handle_failed");
        await this.tell(m.conversationId, `Could not deliver the message: ${why}`);
      });
    });
  }

  /** Post a system notice; a notice that cannot be posted is logged, never lost silently. */
  private async tell(conversationId: ConversationId, text: string): Promise<void> {
    await this.deps.surface
      .post(conversationId, { author: { kind: "system" }, text })
      .catch((err) =>
        this.deps.log?.error(
          { error: err instanceof Error ? err.message : String(err), conversationId },
          "hub.notice_failed",
        ),
      );
  }

  /** A user message: store it and wake the bots it addresses. */
  async handle(m: InboundMessage): Promise<void> {
    const { store, clock } = this.deps;
    const conv = await store.conversations.get(m.conversationId);
    if (!conv) return;
    this.noticed = new Set([...this.noticed].filter((k) => !k.startsWith(`${conv.id}|`)));
    const user: Author = { kind: "user" };
    await store.messages.append({
      conversationId: conv.id,
      author: user,
      text: m.text,
      at: clock.now(),
    });
    for (const target of await this.targets(conv, m.text))
      await this.wake(target, conv.id, user, m.text, 0, {
        ...(m.attachments && { attachments: m.attachments }),
      });
  }

  /** Stop one bot's session and its background tasks. */
  async stop(botId: BotId): Promise<void> {
    const entry = this.pool.entry(botId);
    if (!entry) return;
    entry.stopping = true;
    this.pool.remove(botId);
    await entry.session.stop();
  }

  async stopAll(): Promise<void> {
    for (const e of this.pool.list()) await this.stop(e.bot.id);
  }

  status(): BotStatus[] {
    return this.pool.list().map((e) => ({
      botId: e.bot.id,
      sessionId: e.session.id,
      busy: e.busy,
      tasks: [...e.tasks].map(([taskId, t]) => ({ taskId, description: t.description })),
    }));
  }

  /** Close sessions that have been quiet for `idleCloseMs` and run no background task. */
  async sweepIdle(): Promise<void> {
    const now = this.deps.clock.now();
    for (const e of this.pool.list())
      if (!e.busy && e.tasks.size === 0 && now - e.lastActive >= this.limits.idleCloseMs)
        await this.stop(e.bot.id);
  }

  /** Bots a user message in `conv` wakes. */
  private async targets(conv: Conversation, text: string): Promise<BotId[]> {
    const { store } = this.deps;
    if (conv.kind === "direct") {
      const bot = await store.bots.get(conv.botId);
      return bot ? routeMessage(conv, undefined, [bot], text) : [];
    }
    const group = await store.groups.get(conv.groupId);
    if (!group) return [];
    const members = (await Promise.all(group.members.map((id) => store.bots.get(id)))).filter(
      (b): b is Bot => b !== undefined,
    );
    return routeMessage(conv, group, members, text);
  }

  /** Deliver one message to one bot unless a cap says stop. */
  private async wake(
    botId: BotId,
    conversationId: ConversationId,
    sender: Author,
    text: string,
    hop: number,
    opts: WakeOpts = {},
  ): Promise<WakeOutcome> {
    const { store } = this.deps;
    const bot = await store.bots.get(botId);
    const conv = await store.conversations.get(conversationId);
    if (!bot || !conv) return { ok: false, reason: "gone" };
    // The wake is stored first, so a blocked one is on record with its reason.
    const row = await this.wakeLog.create({
      conversationId,
      targetBot: botId,
      sender,
      intent: opts.intent ?? "request",
      hop,
      text,
      ...(opts.handoff && { handoff: true }),
      ...(opts.attachments && { attachments: opts.attachments }),
      ...(opts.chainId && { chainId: opts.chainId }),
      ...(opts.parentWakeId && { parentWakeId: opts.parentWakeId }),
    });
    return this.admit(row, bot, opts);
  }

  /** Check the caps for a stored wake, then hand it to the bot's session (now, or after its current turn). */
  private async admit(
    row: WakeRow,
    bot: Bot,
    opts: { exemptFromHops?: boolean; interrupted?: boolean } = {},
  ): Promise<WakeOutcome> {
    const { store, clock } = this.deps;
    const { conversationId, sender, text, hop } = row;
    // A result that returns to the bot that gave the work is checked as if it were at the last allowed hop.
    const w = {
      conversationId,
      sender,
      target: row.targetBot,
      text,
      hop: opts.exemptFromHops ? Math.min(hop, this.limits.maxHops) : hop,
    };
    const verdict = this.guard.check(w);
    if (!verdict.ok) {
      await this.wakeLog.blocked(row, verdict.reason);
      await this.notice(conversationId, verdict.reason);
      return { ok: false, reason: verdict.reason };
    }
    if (
      (await store.spend.total(bot.id, dayOf(clock.now()))) >= this.limits.maxSpendPerBotPerDayUsd
    ) {
      await this.wakeLog.blocked(row, "spend");
      await this.notice(conversationId, "spend");
      return { ok: false, reason: "spend" };
    }

    const entry = await this.pool.get(bot);
    if (!entry.pumping) {
      entry.pumping = true;
      this.runPump(entry).catch((err) =>
        this.deps.log?.error({ error: errText(err), botId: bot.id }, "hub.pump_failed"),
      );
    }
    this.guard.record(w);
    // One turn at a time per bot: a message that arrives mid-turn waits, so each answer goes where it was asked.
    const wake: QueuedWake = {
      wakeId: row.id,
      conversationId,
      sender,
      text,
      hop,
      intent: row.intent,
      ...(row.handoff && { handoff: true }),
      ...(opts.interrupted && { interrupted: true }),
      ...(row.attachments && { attachments: row.attachments }),
    };
    if (entry.busy) entry.queue.push(wake);
    else await this.dispatch(entry, wake);
    return { ok: true, wakeId: row.id };
  }

  /**
   * At start, put back what the last run left open. A queued wake is sent as it was (unless it waited over a day:
   * expired); a running one is sent once more with a note that its turn was cut (a second cut: interrupted); a wake
   * whose bot or conversation is gone is dropped. The caps count the wakes sent before the restart.
   */
  async recover(): Promise<void> {
    const { store, clock } = this.deps;
    const now = clock.now();
    const open = await store.wakes.open();
    const openIds = new Set(open.map((r) => r.id));
    const since = now - Math.max(3_600_000, this.limits.repeatWindowMs);
    for (const c of new Set(open.map((r) => r.conversationId)))
      this.guard.seed((await store.wakes.botSentSince(c, since)).filter((r) => !openIds.has(r.id)));
    for (const r of open) {
      const bot = await store.bots.get(r.targetBot);
      const conv = await store.conversations.get(r.conversationId);
      if (!bot || !conv) {
        await this.wakeLog.dropped(r.id);
        continue;
      }
      if (r.status === "queued" && now - r.createdAt > this.limits.wakeExpireMs) {
        await this.wakeLog.expired(r.id);
        await this.tell(
          r.conversationId,
          `A message for ${bot.name} expired while the app was down and was not delivered.`,
        );
        continue;
      }
      const cut = r.status === "running";
      if (cut && r.attempts >= 2) {
        await this.wakeLog.interrupted(r.id);
        await this.tell(
          r.conversationId,
          `${bot.name} was interrupted twice by restarts; the message was not delivered again.`,
        );
        continue;
      }
      const next: WakeRow = { ...r, status: "queued", attempts: cut ? r.attempts + 1 : r.attempts };
      await store.wakes.update(r.id, { status: "queued", attempts: next.attempts });
      this.wakeLog.redelivered(next);
      await this.admit(next, bot, {
        ...(cut && { interrupted: true }),
        ...(r.hop > this.limits.maxHops && { exemptFromHops: true }),
      });
    }
  }

  /** Send one message into the bot's session. */
  private async dispatch(entry: PoolEntry, q: QueuedWake): Promise<void> {
    const { store, surface, clock } = this.deps;
    const conv = await store.conversations.get(q.conversationId);
    const context =
      conv?.kind === "group"
        ? await store.messages.recent(q.conversationId, this.limits.groupContextMessages)
        : [];
    const groupMemory = conv ? await changedGroupMemory(entry, conv, this.deps.memory) : undefined;
    entry.current = { conversationId: q.conversationId, hop: q.hop };
    entry.currentWakeId = q.wakeId;
    entry.turnTexts = [];
    entry.sentResults = new Set();
    entry.busy = true;
    await this.wakeLog.started(q.wakeId);
    entry.lastActive = clock.now();
    surface.showActivity(q.conversationId, { kind: "typing", botId: entry.bot.id });
    try {
      entry.session.send({
        conversationId: q.conversationId,
        from: q.sender,
        text: q.text,
        hop: q.hop,
        intent: q.intent,
        ...(q.handoff && { handoff: true }),
        ...(q.interrupted && { interrupted: true }),
        context,
        ...(q.attachments && { attachments: q.attachments }),
        ...(groupMemory !== undefined && { groupMemory }),
      });
    } catch (err) {
      // A send that fails (for example an unreadable attachment) must not leave the bot busy for good.
      entry.busy = false;
      entry.currentWakeId = undefined;
      await this.wakeLog.dropped(q.wakeId);
      throw err;
    }
  }

  private runPump(entry: PoolEntry): Promise<void> {
    return pumpEvents(entry, this.deps, {
      onBotText: async (e, text) => {
        // Text goes to the channel only; a bot reaches another bot with SendToBot / HandOff.
        e.turnTexts.push(text);
        if (e.currentWakeId) await this.wakeLog.firstText(e.currentWakeId);
      },
      onTurnEnd: async (e) => {
        e.busy = false;
        await this.returnOutcome(e);
        if (e.currentWakeId) await this.wakeLog.done(e.currentWakeId);
        e.currentWakeId = undefined;
        // A queued message that cannot be sent is reported; the next one still gets its turn.
        for (let next = e.queue.shift(); next; next = e.queue.shift()) {
          try {
            await this.dispatch(e, next);
            break;
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            this.deps.log?.error({ error: why, botId: e.bot.id }, "hub.dispatch_failed");
            await this.tell(next.conversationId, `Could not deliver the message: ${why}`);
          }
        }
      },
      onClosed: async (e, crashed, reason) => {
        if (this.pool.entry(e.bot.id) === e) this.pool.remove(e.bot.id);
        // The turn that was running ends here, and the messages that waited behind it are not delivered.
        if (e.currentWakeId) await this.wakeLog.interrupted(e.currentWakeId);
        e.currentWakeId = undefined;
        for (const q of e.queue) await this.wakeLog.dropped(q.wakeId);
        e.queue = [];
        if (!crashed) return;
        // A crashed session must not stay alive next to the one the next message resumes.
        e.stopping = true;
        await e.session
          .stop()
          .catch((err) =>
            this.deps.log?.error({ error: errText(err), botId: e.bot.id }, "hub.stop_failed"),
          );
        await this.tell(
          e.current.conversationId,
          `${e.bot.name} stopped unexpectedly${reason ? `: ${reason}` : ""}. Send a message to continue.`,
        );
      },
    });
  }

  /** A bot's `SendToBot` / `HandOff`: deliver a message to a member of the group it is answering in. */
  async send(from: BotId, req: SendRequest): Promise<SendResult> {
    const entry = this.pool.entry(from);
    // Read now: the entry moves on to its next turn while this call awaits.
    const wakeId = entry?.currentWakeId;
    if (!entry || !wakeId || !entry.current.conversationId)
      return { ok: false, error: "You can send a message only while you answer one." };
    return this.deliver(entry, { ...entry.current, wakeId }, req, true);
  }

  /**
   * Check one bot-to-bot message and wake its target. `cur` is the wake the sender is answering; `post` shows the
   * message in the channel under the sender's name (an automatic result is the bot's own text, already shown).
   */
  private async deliver(
    entry: PoolEntry,
    cur: { conversationId: ConversationId; hop: number; wakeId: string },
    req: SendRequest,
    post: boolean,
  ): Promise<SendResult> {
    const { store, surface, clock } = this.deps;
    const fail = (error: string): SendResult => ({ ok: false, error });
    const text = clampBotMessage(req.text);
    if (!text) return fail("The message is empty.");
    const conv = await store.conversations.get(cur.conversationId);
    if (conv?.kind !== "group") return fail("Messages between bots work in group chats only.");
    const group = await store.groups.get(conv.groupId);
    const members = (
      await Promise.all((group?.members ?? []).map((id) => store.bots.get(id)))
    ).filter((b): b is Bot => b !== undefined);
    const q = req.to.trim();
    const named = members.filter((b) => b.name.toLowerCase() === q.toLowerCase());
    const target = members.find((b) => b.id === q) ?? (named.length === 1 ? named[0] : undefined);
    if (!target) return fail(`No member of this group has the id or name "${q}".`);
    if (target.id === entry.bot.id) return fail("A bot cannot message itself.");

    const parent = await store.wakes.get(cur.wakeId);
    const hop = nextHop(cur.hop);
    const fromTarget = parent?.sender.kind === "bot" && parent.sender.botId === target.id;
    // A result or status going back to the bot that gave the work may pass the hop limit.
    const returnsToSender =
      fromTarget &&
      (req.intent === "result" || req.intent === "status") &&
      (parent?.intent === "request" || parent?.intent === "question") &&
      !parent?.handoff;
    if (hop > this.limits.maxHops && !returnsToSender)
      return fail(
        "The limit of bot-to-bot messages for this chain is reached; report to the owner instead of messaging another bot.",
      );
    if (req.handoff && fromTarget)
      return fail(
        "Do not hand this step back to the bot that gave it to you; post the result in the channel instead.",
      );

    const author: Author = { kind: "bot", botId: entry.bot.id };
    const outcome = await this.wake(target.id, conv.id, author, text, hop, {
      intent: req.intent,
      ...(req.handoff && { handoff: true }),
      ...(parent && { chainId: parent.chainId }),
      parentWakeId: cur.wakeId,
      ...(returnsToSender && { exemptFromHops: true }),
    });
    if (!outcome.ok) return fail(`Not delivered: the ${outcome.reason} limit is reached.`);
    if (req.intent === "result") entry.sentResults.add(target.id);
    if (post) {
      const line = `→ @${target.name} (${req.handoff ? "hand-off" : req.intent}): ${text}`;
      await surface
        .post(conv.id, { author, text: line })
        .catch((err) =>
          this.deps.log?.error({ error: errText(err), conversationId: conv.id }, "hub.post_failed"),
        );
      await store.messages.append({ conversationId: conv.id, author, text: line, at: clock.now() });
    }
    return {
      ok: true,
      wakeId: outcome.wakeId,
      note: req.handoff
        ? `Handed to ${target.name}. End this turn without narrating it; ${target.name} owns the step now.`
        : `Sent to ${target.name}. Delivery is asynchronous; an answer wakes you later as a new message. Continue independent work and send another update only if it adds something new.`,
    };
  }

  /**
   * A turn woken by a request or question ends: its last text goes back to the sender as a result, unless the bot
   * already sent that sender a result in this turn. A hand-off is never answered this way.
   */
  private async returnOutcome(e: PoolEntry): Promise<void> {
    if (!e.currentWakeId) return;
    const w = await this.deps.store.wakes.get(e.currentWakeId);
    if (w?.sender.kind !== "bot" || w.handoff) return;
    if (w.intent !== "request" && w.intent !== "question") return;
    if (e.sentResults.has(w.sender.botId)) return;
    const text = e.turnTexts.at(-1);
    if (!text?.trim()) return;
    const res = await this.deliver(
      e,
      { conversationId: w.conversationId, hop: w.hop, wakeId: w.id },
      { to: w.sender.botId, text, intent: "result" },
      false,
    );
    if (!res.ok) this.deps.log?.warn({ error: res.error, wakeId: w.id }, "hub.result_not_returned");
  }

  /** Post one "Stopped: <reason> limit reached." per conversation until the user writes again. */
  private async notice(conversationId: ConversationId, reason: string): Promise<void> {
    const key = `${conversationId}|${reason}`;
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    await this.deps.surface.post(conversationId, {
      author: { kind: "system" },
      text: `Stopped: ${reason} limit reached.`,
    });
  }
}
