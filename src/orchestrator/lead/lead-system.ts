import { LEAD_POOL_MAX, LEAD_WAITING_MAX } from "../../config/run-caps";
import type { InboundMessage } from "../../ingress/discord-message-handler";
import { messageLanguage, renderUserNotice } from "../../ingress/user-copy";
import { logEvent, logger } from "../../observability/logger";
import { getThread } from "../../storage/thread-store";
import { channelLocations, selectWorkspace } from "../../workspaces/task-workspace";
import type { DispatchDeps } from "../run/role-run-types";
import { createRunLimiter } from "../turns/run-limiter";
import { dispatchReady } from "../worker/dispatch-ready";
import { createQuestionRelay } from "../worker/question-relay";
import type { RecoveryReport } from "../worker/recover-in-flight";
import { startResilienceSweeper } from "../worker/resilience-sweeper";
import { answerReply } from "./lead-answer-reply";
import { announceRearmDelay, createAnnouncer } from "./lead-events";
import { appendOwnerEvent, closeOwnerEvents, replayOwnerInputs } from "./lead-owner-events";
import { createLeadQueue, type LeadQueue } from "./lead-queue";
import { runLead } from "./lead-run";
import { type LeadRuntime, type LeadThreadCtx, postTo } from "./lead-runtime";

/** Logger of this module. */
const log = logger.child({ module: "lead-system" });

/** The lead system of a process: the queue the owner's messages and the news go into, and what feeds it. */
export interface LeadSystem {
  rt: LeadRuntime;
  queue: LeadQueue;
  /** Remember the thread's facts from the owner's message (workspace, channel, locations, how to post). */
  remember(message: InboundMessage): LeadThreadCtx | { refusal: string };
  /** An owner message for the lead: append its `owner_message` event and queue the input. */
  submit(message: InboundMessage): void;
  /** A reply to a waiting task's question message resumes it (see lead-answer-reply.ts); false = a plain message. */
  answerReply(message: InboundMessage): boolean;
  /** Boot: wake the lead of every thread that has undelivered events (recovered tasks, unfinished news). */
  wake(report: RecoveryReport): void;
  /** `/stop`: drop the thread's queued inputs and announce timer, end its workers' question waits. */
  stopThread(threadId: string): void;
  /** Shutdown: drop queued inputs and timers (the watchdog's too), end every worker wait. */
  stopAll(): void;
}

/**
 * Build the lead system: the question relay, the announcer, the lead queue (the lead runner + the lead pool)
 * and the per-thread facts. `post` posts into a thread when no owner message of it was seen in this process (boot wake).
 */
export function createLeadSystem(o: {
  deps: DispatchDeps;
  post?: (threadId: string, text: string) => Promise<void>;
  /** Keep a lead run in the shutdown drain. */
  track?: (run: Promise<void>) => void;
  /** The thread's rollover work after a lead run, and the wait for it. */
  afterRun?: LeadRuntime["afterRun"];
  hold?: LeadRuntime["hold"];
  announceWindowMs?: number;
  debounceMs?: number;
}): LeadSystem {
  const { deps } = o;
  const threads = new Map<string, LeadThreadCtx>();
  /** Facts of a thread from the db when this process never saw its messages (boot wake): needs `post`. */
  const fromDb = (threadId: string): LeadThreadCtx | undefined => {
    const row = getThread(deps.db, threadId);
    if (!row || !o.post) return undefined;
    const picked = selectWorkspace(deps.config.agentHome, row.channel_id);
    if ("reply" in picked) return undefined;
    const post = o.post;
    const ctx: LeadThreadCtx = {
      workspace: picked.ws.name,
      channel: picked.channel.name,
      channelMode: picked.channel.mode,
      channelId: row.channel_id,
      locations: channelLocations(picked.ws, picked.channel),
      message: {
        source: "discord",
        userId: deps.config.ownerDiscordId ?? "",
        threadId,
        channelId: row.channel_id,
        text: "",
        notify: (text) => post(threadId, text),
      },
    };
    threads.set(threadId, ctx);
    return ctx;
  };
  let announcer: ReturnType<typeof createAnnouncer> | undefined;
  const relay = createQuestionRelay(deps.db, (threadId) => announcer?.notify(threadId));
  const rt: LeadRuntime = {
    deps,
    ctxOf: (threadId) => threads.get(threadId) ?? fromDb(threadId),
    refresh: (threadId) => {
      const ctx = threads.get(threadId);
      const picked = ctx && selectWorkspace(deps.config.agentHome, ctx.channelId);
      if (ctx && picked && !("reply" in picked))
        ctx.locations = channelLocations(picked.ws, picked.channel);
    },
    announce: (threadId) => announcer?.notify(threadId),
    relay,
    afterRun: o.afterRun,
    hold: o.hold,
  };
  /** Per thread: announces the full lead pool dropped in a row (the re-arm delay grows with it; a lead run of the thread resets it). */
  const dropStreak = new Map<string, number>();
  const queue = createLeadQueue({
    run: (input) => {
      dropStreak.delete(input.threadId);
      const run = runLead(rt, input);
      o.track?.(run);
      return run;
    },
    pool: deps.leadPool ?? createRunLimiter(LEAD_POOL_MAX, LEAD_WAITING_MAX),
    // The owner is told once that the input waits for a lead slot, or that it was not taken (waiting bound / thread queue full).
    onQueued: (input, full) => {
      const ctx = rt.ctxOf(input.threadId);
      if (ctx)
        void postTo(
          ctx,
          renderUserNotice({ kind: "queue", full }, messageLanguage(ctx.message)),
        ).catch(() => undefined);
    },
    // An owner input dropped on purpose (`/stop`, cap, refusal) is closed: the boot replay must not bring it back.
    onDiscarded: (input) => closeOwnerEvents(deps.db, input.messageIds),
    // An announce dropped (pool full, queue cap) leaves its news undelivered: arm it again, later each time it is refused.
    onDropped: (input) => {
      const streak = dropStreak.get(input.threadId) ?? 0;
      dropStreak.set(input.threadId, streak + 1);
      announcer?.notify(input.threadId, announceRearmDelay(streak, o.announceWindowMs));
    },
    stopping: deps.stopping,
    debounceMs: o.debounceMs,
  });
  announcer = createAnnouncer({ db: deps.db, push: queue.push, windowMs: o.announceWindowMs });
  // The watchdog tick over the live worker runs (unref'd timer); stopped with the rest at shutdown.
  const stopSweeper = startResilienceSweeper(rt);
  return {
    rt,
    queue,
    remember(message) {
      const picked = selectWorkspace(deps.config.agentHome, message.channelId);
      if ("reply" in picked) return { refusal: picked.reply };
      const ctx: LeadThreadCtx = {
        workspace: picked.ws.name,
        channel: picked.channel.name,
        channelMode: picked.channel.mode,
        channelId: message.channelId,
        locations: channelLocations(picked.ws, picked.channel),
        message,
      };
      threads.set(message.threadId, ctx);
      return ctx;
    },
    submit(message) {
      // The event id carries the message id: the run that reads this input closes exactly this event.
      const messageId = message.messageId ?? crypto.randomUUID();
      appendOwnerEvent(deps.db, { threadId: message.threadId, messageId, text: message.text });
      queue.push({
        threadId: message.threadId,
        kind: "owner",
        messageIds: [messageId],
        text: message.text,
      });
    },
    answerReply: (message) => answerReply(rt, message),
    wake(report) {
      for (const threadId of report.threads) {
        logEvent(log, "lead.wake", { threadId });
        for (const input of replayOwnerInputs(deps.db, threadId)) queue.push(input);
        queue.push({ threadId, kind: "announce", messageIds: [] });
        void dispatchReady(rt, threadId); // work orders the crash left unstarted
      }
      // Items waiting in `ready` (boot resume, or the shutdown abort's resume) start without any owner message or lead run.
      for (const threadId of [...report.readyThreads, ...report.waveThreads])
        if (!report.threads.includes(threadId)) void dispatchReady(rt, threadId);
    },
    stopThread(threadId) {
      queue.stop(threadId);
      announcer?.cancel(threadId);
      relay.abortThread(threadId);
    },
    stopAll() {
      stopSweeper();
      announcer?.stopAll();
      queue.stopAll();
      relay.abortAll();
    },
  };
}
