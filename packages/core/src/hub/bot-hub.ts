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
import { applyConfigChange, type ConfigChange } from "../runs/run-config-change";
import { createRun } from "../runs/run-create";
import { InProcessHints } from "../runs/run-hints";
import { intakeOwnerMessage } from "../runs/run-intake";
import { LocalRunner } from "../runs/run-local-runner";
import { groupOfScopeKey } from "../runs/run-rules";
import { stopScope } from "../runs/run-stop";
import { ScheduleBoard } from "../schedules/schedule-board";
import type { Ticket } from "../tickets/ticket";
import { TicketBoard } from "../tickets/ticket-board";
import { sendFromSession } from "./bot-messaging";
import { type HubContext, tell } from "./hub-context";
import { type BotHubDeps, type BotStatus, errText } from "./hub-types";
import { sweepQuietScopes } from "./idle-close";
import { queueIntroRun } from "./intro-run";
import { releaseDependents } from "./ticket-dependents";
import { followUpStatus } from "./ticket-followups";
import { postBlockedComment, postBlockedReason, postTicketMilestone } from "./ticket-milestones";
import { ownerComment } from "./ticket-owner-comment";
import { wakeForTicket } from "./ticket-wakes";
import { admit, wake } from "./wake-admission";
import { WakeLog } from "./wake-log";
import { recoverWakes } from "./wake-recovery";

export type { BotHubDeps, BotStatus } from "./hub-types";

/**
 * Drives the bots: routes each user message to the right bots as stored runs, carries a bot's `SendToBot` /
 * `HandOff` to its target, and applies the loop, rate and spend caps. Without `deps.hints`, or with
 * `deps.runner` (a worker process), it also executes runs in this process (`LocalRunner`: one claimed run = one
 * session turn). The work lives in the focused files
 * beside this one; this class owns the shared state and the public API.
 */
export class BotHub implements BotMessenger {
  /** What the parts of the hub share. */
  private ctx: HubContext;
  /** The shared ticket board; assigning a ticket wakes its assignee through this hub. */
  readonly tickets: TicketBoard;
  /** The schedules; their fires become runs of this hub. */
  readonly schedules: ScheduleBoard;
  /** Executes the runs in this process; unset when `deps.hints` is given without `deps.runner` (main with workers). */
  private runner?: LocalRunner;

  constructor(private deps: BotHubDeps) {
    this.tickets = new TicketBoard({
      store: deps.store,
      clock: deps.clock,
      wake: (t, botId, actor) => this.wakeForTicket(t, botId, false, actor),
      ...(deps.onTicketChange && { onChange: deps.onTicketChange }),
      onStatusChange: (t, c) =>
        postTicketMilestone(this.ctx, t, c.from)
          .then(() => followUpStatus(this.ctx, t, c))
          .then(() => releaseDependents(this.ctx, t)),
      onComment: (t, c) => postBlockedComment(this.ctx, t, c),
      onBlockedReason: (t) => postBlockedReason(this.ctx, t),
      ...(deps.secretValues && { secretValues: deps.secretValues }),
    });
    const limits = deps.limits ?? CORE_DEFAULTS;
    const local = deps.hints ? undefined : new InProcessHints();
    this.ctx = {
      deps,
      limits,
      runs: new Map(),
      guard: new ChainGuard(deps.store, deps.clock, limits),
      wakeLog: new WakeLog(deps.store, deps.clock, deps.log),
      hints: deps.hints ?? (local as InProcessHints),
      tickets: this.tickets,
      noticed: new Set(),
      reactedAt: new Map(),
      admit: (row, bot, opts) => admit(this.ctx, row, bot, opts),
      wake: (botId, conversationId, sender, text, hop, opts) =>
        wake(this.ctx, botId, conversationId, sender, text, hop, opts),
    };
    this.schedules = new ScheduleBoard({
      store: deps.store,
      clock: deps.clock,
      timeZone: deps.timeZone ?? (() => "UTC"),
      createRun: (r) => createRun(this.ctx, r),
      tell: (conversationId, text) => tell(this.ctx, conversationId, text),
      notifyFinished: (e) => deps.surface.notifyFinished(e),
      ...(deps.nextRunAt && { nextRunAt: deps.nextRunAt }),
      ...(deps.log && { log: deps.log }),
      ...(deps.onScheduleChange && { onChange: deps.onScheduleChange }),
    });
    if (local) this.runner = new LocalRunner(this.ctx, local, deps.freeMemoryMb);
    else if (deps.runner)
      this.runner = new LocalRunner(this.ctx, deps.runner.hints, deps.freeMemoryMb, deps.runner);
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
   * Stop the runs of a bot (any process): all of them, only the direct one (`"direct"`), or only the one for
   * group `only`. Queued and parked runs are cancelled too, their cards withdrawn, and the sessions of runs in
   * this process stopped before this resolves. Returns how many runs were cancelled.
   */
  async stop(botId: BotId, only?: "direct" | GroupId): Promise<number> {
    return (await stopScope(this.ctx, { botId, ...(only && { only }) })).stopped;
  }

  /**
   * Stop the group-chat runs of every member in group `groupId` (their direct and ticket runs go on: those are
   * stopped from the DM). Returns how many were cancelled.
   */
  async stopGroup(groupId: GroupId): Promise<number> {
    return (await stopScope(this.ctx, { groupId, only: "chat" })).stopped;
  }

  /**
   * Shut down: abort every run of this process (their rows go back to queued) and stop claiming. With
   * `maxWaitMs`, waits at most that long; resolves false when some run did not settle in time.
   */
  async stopAll(maxWaitMs?: number): Promise<boolean> {
    return (await this.runner?.stop(maxWaitMs)) ?? true;
  }

  /** Apply a config reload to the stored runs: removed bots and groups are cancelled, changed scopes reset. */
  configChanged(change: ConfigChange): Promise<void> {
    return applyConfigChange(this.ctx, change);
  }

  /** One entry per run a worker holds or that is parked on a card, read from the rows (any process). */
  async status(): Promise<BotStatus[]> {
    const rows = await this.deps.store.wakes.inFlight();
    return Promise.all(
      rows.map(async (w) => {
        const groupId = groupOfScopeKey(w.scopeKey);
        // Background tasks live in the executing process; only a run of this process knows them.
        const local = [...this.ctx.runs.values()].find((e) => e.row.id === w.id);
        return {
          botId: w.targetBot,
          ...(groupId !== undefined && { groupId }),
          sessionId: (await this.deps.store.sessions.get(w.scopeKey)) ?? "",
          busy: w.status !== "waiting_input",
          parked: w.status === "waiting_input",
          openedAt: w.startedAt ?? w.createdAt,
          tasks: [...(local?.tasks ?? [])].map(([taskId, t]) => ({
            taskId,
            description: t.description,
          })),
        };
      }),
    );
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

  /** A worker process: begin claiming runs (the main process has recovered the rows of the last boot). */
  startRunner(): void {
    this.runner?.start();
  }

  /** Wake the assignee of a ticket in its own direct conversation; nothing is posted to the channel. */
  async wakeForTicket(
    ticket: Ticket,
    botId: BotId,
    rewake = false,
    actor: Author = { kind: "system" },
  ): Promise<void> {
    await wakeForTicket(this.ctx, ticket, botId, rewake, actor);
  }

  /** The owner's comment on a ticket: saved, and it wakes the assignee with the comment text (see `ownerComment`). */
  ownerComment(
    ref: string,
    body: string,
    opts?: { commentId?: string; dedupeKey?: string },
  ): ReturnType<typeof ownerComment> {
    return ownerComment(this.ctx, ref, body, opts);
  }

  /** Queue the intro run of a new bot (one per bot; see `queueIntroRun`). */
  queueIntroRun(botId: BotId): Promise<void> {
    return queueIntroRun(this.ctx, botId);
  }

  /** A bot's `SendToBot` / `HandOff` from session `sessionKey`: deliver a message to a member of its group. */
  send(sessionKey: string, req: SendRequest): Promise<SendResult> {
    return sendFromSession(this.ctx, sessionKey, req);
  }
}
