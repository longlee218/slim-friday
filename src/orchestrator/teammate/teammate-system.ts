import { TEAMMATE_POOL_MAX, TEAMMATE_WAITING_MAX } from "../../config/run-caps";
import type { InboundMessage } from "../../ingress/inbound-message";
import { messageLanguage, renderUserNotice } from "../../ingress/user-copy";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { unpostedPeerMessages } from "../../storage/peer-message-store";
import { getThread, recordBotThread } from "../../storage/thread-store";
import {
  flushPeerOutbox,
  type PeerSendDeps,
  sendPeerMessage,
} from "../../teammates/peer/send-peer-message";
import { channelLocations, selectWorkspace } from "../../workspaces/task-workspace";
import { loadWorkspaces } from "../../workspaces/workspace-registry";
import type { DispatchDeps } from "../run/role-run-types";
import { createRunLimiter } from "../turns/run-limiter";
import { dispatchReady } from "../worker/dispatch-ready";
import { createQuestionRelay } from "../worker/question-relay";
import type { RecoveryReport } from "../worker/recover-in-flight";
import { startResilienceSweeper } from "../worker/resilience-sweeper";
import { answerReply } from "./teammate-answer-reply";
import { announceRearmDelay, createAnnouncer } from "./teammate-events";
import { appendOwnerEvent, closeOwnerEvents, replayOwnerInputs } from "./teammate-owner-events";
import { createTeammateQueue, type TeammateQueue } from "./teammate-queue";
import { runTeammate } from "./teammate-run";
import { postTo, type TeammateRuntime, type TeammateThreadCtx } from "./teammate-runtime";

/** Logger of this module. */
const log = logger.child({ module: "teammate-system" });

/** The teammate system of a process: the queue the owner's messages and the news go into, and what feeds it. */
export interface TeammateSystem {
  rt: TeammateRuntime;
  queue: TeammateQueue;
  /** Remember the thread's facts from the owner's message (workspace, channel, locations, how to post). */
  remember(message: InboundMessage): TeammateThreadCtx | { refusal: string };
  /** An owner message for the teammate: append its `owner_message` event and queue the input. */
  submit(message: InboundMessage): void;
  /** A reply to a waiting task's question message resumes it (see teammate-answer-reply.ts); false = a plain message. */
  answerReply(message: InboundMessage): boolean;
  /** Boot: wake the teammate of every thread that has undelivered events (recovered tasks, unfinished news). */
  wake(report: RecoveryReport): void;
  /** `/stop`: drop the thread's queued inputs and announce timer, end its workers' question waits. */
  stopThread(threadId: string): void;
  /** Shutdown: drop queued inputs and timers (the watchdog's too), end every worker wait. */
  stopAll(): void;
}

/**
 * Build the teammate system: the question relay, the announcer, the teammate queue (the teammate runner + the teammate pool)
 * and the per-thread facts. `post` posts into a thread when no owner message of it was seen in this process (boot wake).
 */
export function createTeammateSystem(o: {
  deps: DispatchDeps;
  post?: (threadId: string, text: string) => Promise<void>;
  /** Open a new thread in a channel (a peer request to a task-mode teammate); returns its id. */
  openThread?: (channelId: string, name: string) => Promise<string>;
  /** Keep a teammate run in the shutdown drain. */
  track?: (run: Promise<void>) => void;
  announceWindowMs?: number;
  debounceMs?: number;
}): TeammateSystem {
  const { deps } = o;
  const threads = new Map<string, TeammateThreadCtx>();
  /** Facts of a thread from the db when this process never saw its messages (boot wake): needs `post`. */
  const fromDb = (threadId: string): TeammateThreadCtx | undefined => {
    const row = getThread(deps.db, threadId);
    if (!row || !o.post) return undefined;
    const picked = selectWorkspace(deps.config.agentHome, row.channel_id);
    if ("reply" in picked) return undefined;
    const post = o.post;
    const ctx: TeammateThreadCtx = {
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
  const rt: TeammateRuntime = {
    deps,
    ctxOf: (threadId) => threads.get(threadId) ?? fromDb(threadId),
    refresh: (threadId) => {
      const ctx = threads.get(threadId);
      const picked = ctx && selectWorkspace(deps.config.agentHome, ctx.channelId);
      if (ctx && picked && !("reply" in picked))
        ctx.locations = channelLocations(picked.ws, picked.channel);
    },
    announce: (threadId, delayMs) => announcer?.notify(threadId, delayMs),
    relay,
  };
  /** Peer messages: where a NEW conversation with a teammate lands, how lines are posted, who is woken. */
  const peerDeps: PeerSendDeps = {
    db: deps.db,
    now: Date.now,
    post: (threadId, text) =>
      o.post ? o.post(threadId, text) : Promise.reject(new Error("no post")),
    announce: (threadId) => announcer?.notify(threadId),
    newTargetThread: async (target, sender) => {
      const home = deps.config.agentHome;
      const ws = loadWorkspaces(home).workspaces.find((w) =>
        w.channelDefs.some((c) => c.id === target.channelId),
      );
      const mode = ws?.channelDefs.find((c) => c.id === target.channelId)?.mode;
      if (!ws || !mode) throw new Error(`channel of ${target.name} is not mapped to a space`);
      // Chat mode: the channel is the thread (needs a row so a boot wake can rebuild its facts). Task mode: a new thread.
      if (mode === "chat") {
        recordBotThread(deps.db, target.channelId, target.channelId, ws.name, "");
        return target.channelId;
      }
      if (!o.openThread) throw new Error("cannot open a thread");
      const name = `from ${sender}`.slice(0, 90);
      const id = await o.openThread(target.channelId, name);
      recordBotThread(deps.db, id, target.channelId, ws.name, name);
      return id;
    },
  };
  rt.peerSend = (from, m) => sendPeerMessage(peerDeps, from, m);
  /** Per thread: announces the full teammate pool dropped in a row (the re-arm delay grows with it; a teammate run of the thread resets it). */
  const dropStreak = new Map<string, number>();
  const queue = createTeammateQueue({
    run: (input) => {
      dropStreak.delete(input.threadId);
      const run = runTeammate(rt, input);
      o.track?.(run);
      return run;
    },
    pool: deps.teammatePool ?? createRunLimiter(TEAMMATE_POOL_MAX, TEAMMATE_WAITING_MAX),
    // The owner is told once that the input waits for a teammate slot, or that it was not taken (waiting bound / thread queue full).
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
      const ctx: TeammateThreadCtx = {
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
      try {
        void flushPeerOutbox(peerDeps, unpostedPeerMessages(deps.db));
      } catch (err) {
        logEvent(log, "peer.flush_failed", { err: errText(err) }, "warn");
      }
      for (const threadId of report.threads) {
        logEvent(log, "teammate.wake", { threadId });
        for (const input of replayOwnerInputs(deps.db, threadId)) queue.push(input);
        queue.push({ threadId, kind: "announce", messageIds: [] });
        void dispatchReady(rt, threadId); // work orders the crash left unstarted
      }
      // Items waiting in `ready` (boot resume, or the shutdown abort's resume) start without any owner message or teammate run.
      for (const threadId of report.readyThreads)
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
