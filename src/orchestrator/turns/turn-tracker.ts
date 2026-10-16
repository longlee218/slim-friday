// A turn is one handled message; the turn of a background role is a task (Rev 11).
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { getLogContext, logEvent, setLogContext, tryLog } from "../../observability/logger";
import { getRole } from "../../roles/role-registry";
import { finishTurn, insertTurn, interruptRunningTurns } from "../../storage/run-store";
import { attachTurnToTask, settleTaskAfterTurn } from "../../tasks/task-resolver";
import { abortAllTaskRuns, pendingTaskRuns, taskRunSettled } from "../engine/task-runs";

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
  /** controller -> promise that resolves when the run that owned it has fully ended (cleanup included). */
  const settled = new WeakMap<AbortController, Promise<void>>();
  /** threadId -> promise of a replacement in progress: ordinary messages wait for it before looking at `active`. */
  const reservations = new Map<string, { promise: Promise<void>; cancelled: boolean }>();
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
    /**
     * Make `controller` the thread's active one and return the function the run calls in `finally` when it has
     * ended. `sameRunAs` = a fresh controller of the SAME run (the queue after `/stop`): it settles with that run.
     */
    registerActive(
      threadId: string,
      controller: AbortController,
      sameRunAs?: AbortController,
    ): () => void {
      active.set(threadId, controller);
      const shared = sameRunAs && settled.get(sameRunAs);
      if (shared) {
        settled.set(controller, shared);
        return () => {};
      }
      let settle!: () => void;
      settled.set(
        controller,
        new Promise<void>((r) => {
          settle = r;
        }),
      );
      return settle;
    },
    /** Resolves when the run that owned this exact controller has ended (already ended / unknown = now). */
    activeSettled: (_threadId: string, controller: AbortController): Promise<void> =>
      settled.get(controller) ?? taskRunSettled(controller) ?? Promise.resolve(),
    /** Hold the thread for a replacement: later ordinary messages wait on `waitReplacement` until `release`. */
    reserveReplacement(threadId: string): { release: () => void; isCancelled: () => boolean } {
      let release!: () => void;
      const entry = { promise: undefined as unknown as Promise<void>, cancelled: false };
      entry.promise = new Promise<void>((r) => {
        release = () => {
          if (reservations.get(threadId) === entry) reservations.delete(threadId);
          r();
        };
      });
      reservations.set(threadId, entry);
      return { release, isCancelled: () => entry.cancelled };
    },
    /** `/stop` while a replacement is pending: that replacement must not start. True when one was pending. */
    cancelReplacement(threadId: string): boolean {
      const entry = reservations.get(threadId);
      if (entry) entry.cancelled = true;
      return !!entry;
    },
    /** Wait until no replacement holds the thread (the replacement itself never calls this). */
    async waitReplacement(threadId: string): Promise<void> {
      for (let e = reservations.get(threadId); e; e = reservations.get(threadId)) await e.promise;
    },
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
