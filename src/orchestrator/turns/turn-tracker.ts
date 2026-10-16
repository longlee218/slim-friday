// A turn is one handled message; the turn of a background role is a task (Rev 11).
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { getLogContext, logEvent, setLogContext, tryLog } from "../../observability/logger";
import { getRole } from "../../roles/role-registry";
import { finishTurn, insertTurn, interruptRunningTurns } from "../../storage/run-store";
import { attachTurnToTask, settleTaskAfterTurn } from "../../tasks/task-resolver";
import { abortAllTaskRuns, pendingTaskRuns } from "../engine/task-runs";

/** Log-context fields every line of a call carries: a fresh trace id, its thread and its routing channel. */
export const turnLogContext = (t: { threadId: string; channelId: string }) => ({
  traceId: crypto.randomUUID(),
  threadId: t.threadId,
  channelId: t.channelId,
});

/** Tracks calls in flight and the active runs, so shutdown can abort and await them. */
export function createRunTracker(db: Database, log: Logger, active: Map<string, AbortController>) {
  /** Promises of calls in flight. */
  const inflight = new Set<Promise<string | undefined>>();
  /** Set once shutdown aborts the runs: those tasks are `interrupted` (resumable), not user-cancelled. */
  let stopping = false;

  /** Abort every active run (graceful shutdown). */
  const abortAll = () => {
    stopping = true;
    for (const ac of active.values()) ac.abort();
    abortAllTaskRuns(); // detached task runs hold no thread: they are aborted (and drained) too
  };

  return {
    isStopping: () => stopping,
    abortAll,
    /** Keep the call in the in-flight set until it settles (`run` never rejects). */
    track(p: Promise<string | undefined>): Promise<string | undefined> {
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
      await Promise.race([Promise.allSettled([...inflight, ...pendingTaskRuns()]), timeout]);
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
    role: string;
    hop?: number;
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
      role: t.role,
      hop: t.hop,
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
