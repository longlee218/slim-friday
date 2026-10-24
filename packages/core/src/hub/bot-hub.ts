import { CORE_DEFAULTS } from "../config-defaults";
import type { BotId } from "../domain/bot";
import type { GroupId } from "../domain/group";
import type { Author } from "../domain/message";
import type { QuestionAnswer } from "../domain/question";
import type { BotMessenger, SendRequest, SendResult } from "../ports/messenger";
import type { ApprovalAnswer, InboundMessage } from "../ports/surface";
import { ChainGuard } from "../routing/chain-guard";
import { startOutcomeReconciler } from "../runs/outcome-reconciler";
import { type AnswerCardResult, answerCard, remindWaitingCards } from "../runs/run-card-answer";
import { abortRun, type RunExec } from "../runs/run-exec";
import { InProcessHints } from "../runs/run-hints";
import { intakeOwnerMessage } from "../runs/run-intake";
import { LocalRunner } from "../runs/run-local-runner";
import type { Ticket } from "../tickets/ticket";
import { TicketBoard } from "../tickets/ticket-board";
import { sendFromSession } from "./bot-messaging";
import { type HubContext, tell } from "./hub-context";
import { type BotHubDeps, type BotStatus, errText } from "./hub-types";
import { sweepQuietScopes } from "./idle-close";
import { wakeForTicket } from "./ticket-wakes";
import { admit, wake } from "./wake-admission";
import { WakeLog } from "./wake-log";
import { recoverWakes } from "./wake-recovery";

export type { BotHubDeps, BotStatus } from "./hub-types";

/**
 * Drives the bots: routes each user message to the right bots as stored runs, carries a bot's `SendToBot` /
 * `HandOff` to its target, and applies the loop, rate and spend caps. Without `deps.hints` it also executes the
 * runs in this process (`LocalRunner`: one claimed run = one session turn). The work lives in the focused files
 * beside this one; this class owns the shared state and the public API.
 */
export class BotHub implements BotMessenger {
  /** What the parts of the hub share. */
  private ctx: HubContext;
  /** The shared ticket board; assigning a ticket wakes its assignee through this hub. */
  readonly tickets: TicketBoard;
  /** Executes the runs in this process; unset when `deps.hints` names another runner. */
  private runner?: LocalRunner;

  constructor(private deps: BotHubDeps) {
    const limits = deps.limits ?? CORE_DEFAULTS;
    const local = deps.hints ? undefined : new InProcessHints();
    this.ctx = {
      deps,
      limits,
      runs: new Map(),
      guard: new ChainGuard(deps.store, deps.clock, limits),
      wakeLog: new WakeLog(deps.store, deps.clock, deps.log),
      hints: deps.hints ?? (local as InProcessHints),
      noticed: new Set(),
      admit: (row, bot, opts) => admit(this.ctx, row, bot, opts),
      wake: (botId, conversationId, sender, text, hop, opts) =>
        wake(this.ctx, botId, conversationId, sender, text, hop, opts),
    };
    if (local) this.runner = new LocalRunner(this.ctx, local, deps.freeMemoryMb);
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

  /**
   * A user message: store it, then answer a question card, steer a busy run or queue a new run for each bot it
   * addresses; resolves with the stored id (undefined: unknown conversation). Runs are claimed by a worker.
   */
  handle(m: InboundMessage): Promise<number | undefined> {
    return intakeOwnerMessage(this.ctx, m);
  }

  /**
   * Stop the runs this process executes for a bot: all of them, only the direct one (`"direct"`), or only the
   * one for group `only`. Each is cancelled and its session (with its background tasks) stopped; resolves once
   * they have ended, including runs whose session is still opening.
   */
  async stop(botId: BotId, only?: "direct" | GroupId): Promise<void> {
    await this.stopWhere(
      (e) =>
        e.bot.id === botId &&
        (only === undefined || (only === "direct" ? !e.groupId : e.groupId === only)),
    );
  }

  /** Stop the runs of every member in group `groupId` (their direct runs go on). */
  async stopGroup(groupId: GroupId): Promise<void> {
    await this.stopWhere((e) => e.groupId === groupId);
  }

  /** Shut down: abort every run of this process (their rows stay claimable) and stop claiming. */
  async stopAll(): Promise<void> {
    await this.runner?.stop();
  }

  /** Cancel the matching runs and wait until their executions have ended. */
  private async stopWhere(match: (e: RunExec) => boolean): Promise<void> {
    const hit = [...this.ctx.runs.values()].filter(match);
    for (const e of hit) abortRun(e, { kind: "stopped" });
    await Promise.all(hit.map((e) => e.ended));
  }

  /** One entry per run executing in this process. */
  status(): BotStatus[] {
    return [...this.ctx.runs.values()].map((e) => ({
      botId: e.bot.id,
      ...(e.groupId && { groupId: e.groupId }),
      sessionId: e.session?.id ?? "",
      busy: e.turnOpen,
      openedAt: e.openedAt,
      tasks: [...e.tasks].map(([taskId, t]) => ({ taskId, description: t.description })),
    }));
  }

  /** The owner answers card `cardId` (web button): the run is requeued, or told in place while it still runs. */
  answerCard(cardId: string, answer: ApprovalAnswer | QuestionAnswer): Promise<AnswerCardResult> {
    return answerCard(this.ctx, cardId, answer);
  }

  /** Main sweep: one reminder for cards waiting longer than `cardReminderMs`; requeue runs whose card was answered. */
  sweepCards(): Promise<void> {
    return remindWaitingCards(this.ctx, this.deps.clock.now());
  }

  /**
   * Main process: repair what a crash left (held runs, steering of ended runs, unreturned results) now and
   * every `reconcileMs`. Returns the stop function (it waits for a running pass).
   */
  startReconciler(): () => Promise<void> {
    return startOutcomeReconciler(this.ctx, this.ctx.limits);
  }

  /** Tell `onIdleClose` about scopes quiet for `idleCloseMs` (the app flushes their notes). */
  sweepIdle(): Promise<void> {
    return sweepQuietScopes(this.ctx, this.deps.onIdleClose);
  }

  /** At start, check the queued runs the last boot left, then start the in-process runner. */
  async recover(): Promise<void> {
    try {
      await recoverWakes(this.ctx);
    } finally {
      this.runner?.start();
    }
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
