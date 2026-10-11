import type { Logger } from "pino";
import type { Task } from "../ingress/discord-message-handler";
import type { IntentDeps } from "../intent/decide-intent";
import { logEvent } from "../observability/logger";
import { errText } from "../observability/redact";
import { getSession } from "../storage/session-store";
import { selectWorkspace } from "../workspaces/task-workspace";
import type { DispatchDeps } from "./dispatch/dispatch-role";
import { runSideAnswer } from "./dispatch/side-answer";
import { pinnedRepo, replyWhileBusy } from "./intent-turn";
import type { TaskCommand } from "./task-commands";
import type { RunLimiter } from "./tasks/run-limiter";
import { statusSnapshot } from "./tasks/status-snapshot";
import { OUTCOME_REPLY } from "./tasks/task-result";
import type { EffortFloors } from "./thread/effort-floor";
import { SIDE_BUSY } from "./thread/intent-replies";

/* Messages that arrive while the thread's run holds the lock. Two rules live here:
   1. ORDER. The decision of each message (L3, then steer / queue / feedback) runs one after the other per thread, in
      arrival order, so uneven L3 latency cannot reorder them (steers and queued tasks follow the owner's order; the
      `run_messages` seq follows it too). Only the decision is chained: a side answer (minutes) never holds it up.
   2. ACK. The owner sees a reaction on the message at once, before L3 (seconds) and the textual reply. */

/** Reply when a side run crashed (the task's own run is untouched). */
const CRASH_REPLY = OUTCOME_REPLY.error ?? "Agent failed. Check the logs.";

/** Ref that numbers side runs, so each one has its own entry in the active map (shutdown aborts them all). */
let sideSeq = 0;

/** What the lane needs from the handler. */
export interface BusyLaneDeps {
  deps: DispatchDeps;
  log: Logger;
  intent?: IntentDeps;
  floors: EffortFloors;
  limiter?: RunLimiter;
  /** The handler's active-run map: a side run registers here under its own key (never the thread id: not the lock). */
  active: Map<string, AbortController>;
}

/** Build the lane: `(task, parsed, running) => reply` for a message of a thread whose run holds the lock. */
export function createBusyLane(d: BusyLaneDeps) {
  /** threadId -> end of the last decision queued for it. */
  const tails = new Map<string, Promise<unknown>>();

  return function busyReply(task: Task, parsed: TaskCommand, running: AbortController) {
    const threadId = task.threadId;
    if (parsed.kind === "task")
      void Promise.resolve(task.ack?.()).catch((err: unknown) =>
        logEvent(d.log, "task.ack_failed", { err: errText(err) }, "warn"),
      );
    const prev = tails.get(threadId) ?? Promise.resolve();
    const step = prev.then(() =>
      replyWhileBusy({
        deps: d.deps,
        log: d.log,
        task,
        parsed,
        ac: running,
        intent: d.intent,
        floors: d.floors,
      }),
    );
    const tail = step.then(
      () => undefined,
      () => undefined,
    );
    tails.set(threadId, tail);
    void tail.then(() => {
      if (tails.get(threadId) === tail) tails.delete(threadId);
    });
    return step.then(async (out) => {
      if (out.kind === "reply") return out.text;
      if (out.kind !== "side") return CRASH_REPLY;
      // A crashing side run is reported, never thrown: the task's own run is untouched.
      return runSide(d, task, out, running).catch((err: unknown) => {
        logEvent(d.log, "side.crashed", { err: errText(err) }, "error");
        return CRASH_REPLY;
      });
    });
  };
}

/** The side lane of one question: limiter slot, own controller, then the read-only run. */
async function runSide(
  d: BusyLaneDeps,
  task: Task,
  out: Extract<Awaited<ReturnType<typeof replyWhileBusy>>, { kind: "side" }>,
  running: AbortController,
): Promise<string> {
  const picked = selectWorkspace(d.deps.config.agentHome, task.channelId);
  if ("reply" in picked) return picked.reply;
  const release = d.limiter ? d.limiter.tryAcquire() : () => {};
  if (!release) {
    logEvent(d.log, "task.busy", {
      reason: "run_limit",
      side: true,
      active: d.limiter?.active() ?? 0,
    });
    return SIDE_BUSY(d.limiter?.active() ?? 0);
  }
  const ac = new AbortController();
  const stop = () => ac.abort(); // the thread's `/stop` stops its side answers too
  running.signal.addEventListener("abort", stop, { once: true });
  if (running.signal.aborted) stop(); // already stopped: the listener never fires, so abort now
  const key = `${task.threadId}:side:${++sideSeq}`;
  d.active.set(key, ac); // shutdown (abortAll) reaches it; the thread id key stays the task's lock
  try {
    const { ws } = picked;
    const pinned = pinnedRepo(ws.repos, out.repo, getSession(d.deps.db, task.threadId));
    return await runSideAnswer(d.deps, {
      ...out,
      task,
      workspace: ws.name,
      repos: ws.repos,
      pinned,
      ac,
      snapshot: statusSnapshot(d.deps.db, task.threadId),
    });
  } finally {
    running.signal.removeEventListener("abort", stop);
    d.active.delete(key);
    release();
  }
}
