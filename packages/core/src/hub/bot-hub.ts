import { CORE_DEFAULTS, type CoreLimits } from "../config-defaults";
import type { Bot, BotId } from "../domain/bot";
import type { Conversation, ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";
import type { PermissionGate } from "../permission/permission-gate";
import type { AgentRuntime } from "../ports/agent-runtime";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";
import type { InboundMessage, Surface } from "../ports/surface";
import { ChainGuard } from "../routing/chain-guard";
import { routeMessage } from "../routing/route-message";
import { dayOf, pumpEvents } from "./event-pump";
import { type PoolEntry, SessionPool } from "./session-pool";

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
}

/**
 * Drives the bots: routes each user message to the right bots, keeps one session per active bot,
 * turns a bot's mention into a hand-off, and applies the loop, rate and spend caps.
 */
export class BotHub {
  private pool: SessionPool;
  private guard: ChainGuard;
  private limits: CoreLimits;
  /** Caps already announced; cleared when the user writes again in that conversation. */
  private noticed = new Set<string>();

  constructor(private deps: BotHubDeps) {
    this.limits = deps.limits ?? CORE_DEFAULTS;
    this.pool = new SessionPool(deps.runtime, deps.store, deps.clock, deps.gate);
    this.guard = new ChainGuard(deps.clock, this.limits);
  }

  /** Start listening to the surface. */
  start(): void {
    this.deps.surface.onMessage((m) => {
      void this.handle(m);
    });
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
      await this.wake(target, conv.id, user, m.text, 0);
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

  /** Bots a message in `conv` wakes; `sender` is the bot that wrote it (none for the user). */
  private async targets(conv: Conversation, text: string, sender?: BotId): Promise<BotId[]> {
    const { store } = this.deps;
    if (conv.kind === "direct") {
      const bot = await store.bots.get(conv.botId);
      return bot ? routeMessage(conv, undefined, [bot], text, sender) : [];
    }
    const group = await store.groups.get(conv.groupId);
    if (!group) return [];
    const members = (await Promise.all(group.members.map((id) => store.bots.get(id)))).filter(
      (b): b is Bot => b !== undefined,
    );
    return routeMessage(conv, group, members, text, sender);
  }

  /** Deliver one message to one bot unless a cap says stop. */
  private async wake(
    botId: BotId,
    conversationId: ConversationId,
    sender: Author,
    text: string,
    hop: number,
  ): Promise<void> {
    const { store, surface, clock } = this.deps;
    const bot = await store.bots.get(botId);
    const conv = await store.conversations.get(conversationId);
    if (!bot || !conv) return;
    const w = { conversationId, sender, target: botId, text, hop };
    const verdict = this.guard.check(w);
    if (!verdict.ok) return this.notice(conversationId, verdict.reason);
    if ((await store.spend.total(botId, dayOf(clock.now()))) >= this.limits.maxSpendPerBotPerDayUsd)
      return this.notice(conversationId, "spend");

    const entry = await this.pool.get(bot);
    const first = !entry.pumping;
    entry.pumping = true;
    if (first) void this.runPump(entry);
    entry.current = { conversationId, hop };
    entry.busy = true;
    entry.lastActive = clock.now();
    surface.showActivity(conversationId, { kind: "typing", botId });
    const context =
      conv.kind === "group"
        ? await store.messages.recent(conversationId, this.limits.groupContextMessages)
        : [];
    entry.session.send({ conversationId, from: sender, text, hop, context });
    this.guard.record(w);
  }

  private runPump(entry: PoolEntry): Promise<void> {
    return pumpEvents(entry, this.deps, {
      onBotText: async (e, text) => {
        const conv = await this.deps.store.conversations.get(e.current.conversationId);
        if (!conv) return;
        const author: Author = { kind: "bot", botId: e.bot.id };
        for (const t of await this.targets(conv, text, e.bot.id))
          await this.wake(t, conv.id, author, text, e.current.hop + 1);
      },
      onClosed: async (e, crashed, reason) => {
        if (this.pool.entry(e.bot.id) === e) this.pool.remove(e.bot.id);
        if (crashed)
          await this.deps.surface.post(e.current.conversationId, {
            author: { kind: "system" },
            text: `${e.bot.name} stopped unexpectedly${reason ? `: ${reason}` : ""}. Send a message to continue.`,
          });
      },
    });
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
