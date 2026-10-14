// A turn is one handled message; the turn of a background role is a task (Rev 11).
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { TaskClass } from "../../config/model-routing";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { getLogContext, logEvent, setLogContext, tryLog } from "../../observability/logger";
import { getRole } from "../../roles/role-registry";
import { countQueuedProposals } from "../../storage/proposal-store";
import { finishTurn, insertTurn, interruptRunningTurns } from "../../storage/run-store";
import { attachTurnToTask, settleTaskAfterTurn } from "../../tasks/task-resolver";

/** Log-context fields every line of a call carries: a fresh trace id, its thread and its routing channel. */
export const turnLogContext = (t: { threadId: string; channelId: string }) => ({
  traceId: crypto.randomUUID(),
  threadId: t.threadId,
  channelId: t.channelId,
});

/**
 * `stop` (an orchestrator command, never steer): abort the thread's active run at once. The thread's queued tasks
 * are KEPT: they start, in order, once the stopped run has ended (a stop cancels the running work, not the
 * owner's other requests). The run's input channel closes on that abort (nothing more is yielded).
 */
export function stopThread(
  db: Database,
  threadId: string,
  running?: AbortController,
  language: OwnerLanguage = "en",
): string {
  if (!running) return renderUserNotice({ kind: "stop", active: false }, language);
  running.abort();
  const queued = countQueuedProposals(db, threadId);
  return renderUserNotice({ kind: "stop", active: true, queued }, language);
}

/** Register a fresh controller as the thread's active one (the queue that runs after a user `/stop`) and return it. */
export function renewActive(
  active: Map<string, AbortController>,
  threadId: string,
): AbortController {
  const fresh = new AbortController();
  active.set(threadId, fresh);
  return fresh;
}

/** Tracks calls in flight and the active runs, so shutdown can abort and await them. */
export function createRunTracker(db: Database, log: Logger, active: Map<string, AbortController>) {
  /** Promises of calls in flight. */
  const inflight = new Set<Promise<string>>();
  /** Set once shutdown aborts the runs: those tasks are `interrupted` (resumable), not user-cancelled. */
  let stopping = false;

  /** Abort every active run (graceful shutdown). */
  const abortAll = () => {
    stopping = true;
    for (const ac of active.values()) ac.abort();
  };

  return {
    isStopping: () => stopping,
    abortAll,
    /** Keep the call in the in-flight set until it settles (`run` never rejects). */
    track(p: Promise<string>): Promise<string> {
      inflight.add(p);
      const done = () => {
        inflight.delete(p);
      };
      p.then(done, done);
      return p;
    },
    /** Abort all runs, wait up to `timeoutMs` for them to finish, then mark leftovers interrupted. */
    async drain(timeoutMs: number): Promise<void> {
      abortAll();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((r) => {
        timer = setTimeout(r, timeoutMs);
      });
      await Promise.race([Promise.allSettled([...inflight]), timeout]);
      clearTimeout(timer);
      tryLog(log, "interruptRunningTurns failed", () => interruptRunningTurns(db));
    },
  };
}

/**
 * Create the turn row (`brief` = the dispatched task's prompt) and set the log context of the task (location, role). `single` = the only registered
 * workspace: an unpinned task ("*" row) then logs under it. Lines logged before the location is known
 * (message.received, task.started with "*") stay in the main log only; tool-hooks sets the location later
 * for unpinned multi-location tasks.
 */
export function beginTurn(
  db: Database,
  log: Logger,
  ids: { turnId: string; threadId: string; source: string; single?: string },
  t: {
    location: string;
    brief?: string;
    cls?: TaskClass;
    proposalId?: string;
    role: string;
    parentTurnId?: string;
    hop?: number;
    resume?: boolean;
    /** Owned task this turn continues (background roles only; a foreground role never links). */
    ownedTaskId?: string;
  },
): void {
  // Turn row and its task link commit together (no turn without its task, no task without a turn).
  db.transaction(() => {
    insertTurn(db, {
      id: ids.turnId,
      threadId: ids.threadId,
      source: ids.source,
      location: t.location,
      brief: t.brief,
      cls: t.cls,
      proposalId: t.proposalId,
      role: t.role,
      parentTurnId: t.parentTurnId,
      hop: t.hop,
      resume: t.resume,
    });
    // Only a background role works on an owned task: foreground answers (and the side lane) never link.
    if (getRole(t.role).background)
      attachTurnToTask(db, {
        turnId: ids.turnId,
        threadId: ids.threadId,
        owner: t.role,
        scope: t.brief ?? "",
        traceId: getLogContext().traceId ?? crypto.randomUUID(),
        ownedTaskId: t.ownedTaskId,
        resumeOf: t.resume ? t.parentTurnId : undefined,
      });
  })();
  const logLocation = t.location === "*" && ids.single ? ids.single : t.location;
  setLogContext({ location: logLocation, mode: t.role });
  logEvent(log, "task.started", { location: logLocation, type: t.role });
}

/** Log a refused task (`task.refused`) and return the reply text for the owner. */
export function refused(log: Logger, r: { reason: string; reply: string }): string {
  logEvent(log, "task.refused", { reason: r.reason, reply: r.reply });
  return r.reply;
}

/** Mark a turn row `failed` on a crash path. Never throws (the db may be closed during shutdown). */
export function failTurn(db: Database, log: Logger, turnId: string): void {
  tryLog(log, "finishTurn failed", () => {
    finishTurn(db, turnId, "failed");
    settleTaskAfterTurn(db, turnId, "failed");
  });
}
