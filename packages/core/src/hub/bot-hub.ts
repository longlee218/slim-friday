import { CORE_DEFAULTS } from "../config-defaults";
import type { BotId } from "../domain/bot";
import type { GroupId } from "../domain/group";
import type { Author } from "../domain/message";
import type { BotMessenger, SendRequest, SendResult } from "../ports/messenger";
import type { InboundMessage } from "../ports/surface";
import { ChainGuard } from "../routing/chain-guard";
import type { Ticket } from "../tickets/ticket";
import { TicketBoard } from "../tickets/ticket-board";
import { sendFromSession } from "./bot-messaging";
import { type HubContext, tell } from "./hub-context";
import { hubTargets } from "./hub-targets";
import { type BotHubDeps, type BotStatus, errText } from "./hub-types";
import { reportIdleClose } from "./idle-close";
import { type PoolEntry, SessionPool } from "./session-pool";
import { wakeForTicket } from "./ticket-wakes";
import { admit, wake } from "./wake-admission";
import { WakeLog } from "./wake-log";
import { recoverWakes } from "./wake-recovery";

export type { BotHubDeps, BotStatus } from "./hub-types";

/**
 * Drives the bots: routes each user message to the right bots, keeps one session per active bot,
 * carries a bot's `SendToBot` / `HandOff` to its target, and applies the loop, rate and spend caps.
 * The work lives in the focused files beside this one; this class owns the shared state and the public API.
 */
export class BotHub implements BotMessenger {
  /** What the parts of the hub share. */
  private ctx: HubContext;
  /** The shared ticket board; assigning a ticket wakes its assignee through this hub. */
  readonly tickets: TicketBoard;

  constructor(private deps: BotHubDeps) {
    const limits = deps.limits ?? CORE_DEFAULTS;
    this.ctx = {
      deps,
      limits,
      pool: new SessionPool(deps.runtime, deps.store, deps.clock, deps.gate, deps.memory, {
        memoryPromptChars: limits.memoryPromptChars,
        log: deps.log,
        surface: deps.surface,
        approvalTimeoutMs: limits.approvalTimeoutMs,
      }),
      guard: new ChainGuard(deps.clock, limits),
      wakeLog: new WakeLog(deps.store, deps.clock, deps.log),
      noticed: new Set(),
      admit: (row, bot, opts) => admit(this.ctx, row, bot, opts),
      wake: (botId, conversationId, sender, text, hop, opts) =>
        wake(this.ctx, botId, conversationId, sender, text, hop, opts),
    };
    this.tickets = new TicketBoard({
      store: deps.store,
      clock: deps.clock,
      wake: (t, botId, actor) => this.wakeForTicket(t, botId, false, actor),
    });
  }

  /** Start listening to the surface. */
  start(): void {
    this.deps.surface.onMessage((m) =>
      this.handle(m).catch(async (err) => {
        // Never lose a failure: tell the user where it happened.
        const why = errText(err);
        this.deps.log?.error({ error: why, conversationId: m.conversationId }, "hub.handle_failed");
        await tell(this.ctx, m.conversationId, `Could not deliver the message: ${why}`);
        return undefined;
      }),
    );
  }

  /** A user message: store it, wake the bots it addresses; resolves with the stored id (undefined: unknown conversation). */
  async handle(m: InboundMessage): Promise<number | undefined> {
    const { store, clock } = this.deps;
    const conv = await store.conversations.get(m.conversationId);
    if (!conv) return undefined;
    // The user writes again: caps announced in this conversation may be announced again.
    for (const k of [...this.ctx.noticed])
      if (k.startsWith(`${conv.id}|`)) this.ctx.noticed.delete(k);
    const user: Author = { kind: "user" };
    const hasFiles = !!m.files?.length;
    const id = await store.messages.append({
      conversationId: conv.id,
      author: user,
      text: m.text,
      at: clock.now(),
      kind: hasFiles && !m.text.trim() ? "file" : "text",
      ...(m.replyTo !== undefined && { replyTo: m.replyTo }),
      ...(hasFiles && { files: m.files }),
    });
    // A message of files only wakes the bot with a short note instead of an empty text.
    const wakeText = m.text.trim() || `(sent ${m.files?.length ?? 0} file(s))`;
    // A reply to a message of this conversation routes to its bot and carries the quoted text.
    const replied = m.replyTo === undefined ? undefined : await store.messages.get(m.replyTo);
    const quoted = replied?.conversationId === conv.id ? replied : undefined;
    const replyToBot = quoted?.author.kind === "bot" ? quoted.author.botId : undefined;
    for (const target of await hubTargets(store, conv, m.text, replyToBot))
      await this.ctx.wake(target, conv.id, user, wakeText, 0, {
        ...(quoted && { quote: { author: quoted.author, text: quoted.text } }),
        ...(m.attachments && { attachments: m.attachments }),
      });
    return id;
  }

  /**
   * Stop a bot's sessions and their background tasks: all of them, only the direct one (`"direct"`), or only the
   * one for group `only`. Sessions still opening are waited for first, so none is left running.
   */
  async stop(botId: BotId, only?: "direct" | GroupId): Promise<void> {
    await this.ctx.pool.settled(botId);
    for (const e of this.ctx.pool.entriesOf(botId))
      if (only === undefined || (only === "direct" ? !e.groupId : e.groupId === only))
        await this.stopEntry(e);
  }

  /** Stop the sessions every member keeps for group `groupId` (their direct sessions stay). */
  async stopGroup(groupId: GroupId): Promise<void> {
    await this.ctx.pool.settled();
    for (const e of this.ctx.pool.list()) if (e.groupId === groupId) await this.stopEntry(e);
  }

  async stopAll(): Promise<void> {
    await this.ctx.pool.settled();
    for (const e of this.ctx.pool.list()) await this.stopEntry(e);
  }

  /** Stop one session by its key; another session of the same bot is untouched. */
  private async stopEntry(entry: PoolEntry): Promise<void> {
    const { pool } = this.ctx;
    entry.stopping = true;
    if (pool.entry(entry.key) === entry) pool.remove(entry.key);
    await entry.session.stop();
  }

  status(): BotStatus[] {
    return this.ctx.pool.list().map((e) => ({
      botId: e.bot.id,
      ...(e.groupId && { groupId: e.groupId }),
      sessionId: e.session.id,
      busy: e.busy,
      openedAt: e.openedAt,
      tasks: [...e.tasks].map(([taskId, t]) => ({ taskId, description: t.description })),
    }));
  }

  /** Close sessions that have been quiet for `idleCloseMs` and run no background task. */
  async sweepIdle(): Promise<void> {
    const now = this.deps.clock.now();
    for (const e of this.ctx.pool.list())
      if (!e.busy && e.tasks.size === 0 && now - e.lastActive >= this.ctx.limits.idleCloseMs) {
        reportIdleClose(this.deps.onIdleClose, e, this.deps.log);
        await this.stopEntry(e);
      }
  }

  /** At start, put back the wakes the last run left open. */
  recover(): Promise<void> {
    return recoverWakes(this.ctx);
  }

  /** Wake the assignee of a ticket in its own direct conversation; nothing is posted to the channel. */
  wakeForTicket(
    ticket: Ticket,
    botId: BotId,
    rewake = false,
    actor: Author = { kind: "system" },
  ): Promise<void> {
    return wakeForTicket(this.ctx, ticket, botId, rewake, actor);
  }

  /** A bot's `SendToBot` / `HandOff` from session `sessionKey`: deliver a message to a member of its group. */
  send(sessionKey: string, req: SendRequest): Promise<SendResult> {
    return sendFromSession(this.ctx, sessionKey, req);
  }
}
