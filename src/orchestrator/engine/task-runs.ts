/*
 * Registry of the task runs alive in this process: one entry per task (owned task id, else the turn id), whatever
 * thread holds the lock. A run registers when it starts and settles in its own `finally`. The registry is how a
 * thread reaches its runs (stop, steer, status, shutdown) once a run no longer holds the thread.
 */

import { logEvent, logger } from "../../observability/logger";

/** Logger of this module. */
const log = logger.child({ module: "task-runs" });

/** What the registry knows about one live task run. */
export interface TaskRunHandle {
  taskId: string;
  threadId: string;
  turnId: string;
  role: string;
  /** The run's own controller: aborting it stops the run. */
  ac: AbortController;
  /** Registration order (newest = highest). */
  seq: number;
}

/** taskId -> live run. */
const runs = new Map<string, TaskRunHandle>();
/** controller -> promise that resolves when its run has settled (replacement waits on it). */
const settledOf = new WeakMap<AbortController, Promise<void>>();
/** Promises of the live runs (shutdown drain waits on them). */
const pending = new Set<Promise<void>>();
let nextSeq = 0;

/**
 * Register a live task run and return its `settle` function (idempotent; call it in the run's `finally`).
 * A task id that is already live means two runs of one task: the old run is aborted (and logged) before the new
 * one replaces its entry.
 */
export function registerTaskRun(
  taskId: string,
  r: { threadId: string; turnId: string; role: string; ac: AbortController },
): () => void {
  const old = runs.get(taskId);
  if (old) {
    logEvent(log, "task_run.replaced", { taskId, oldTurnId: old.turnId, turnId: r.turnId }, "warn");
    old.ac.abort();
  }
  const handle: TaskRunHandle = { taskId, ...r, seq: nextSeq++ };
  runs.set(taskId, handle);
  let done!: () => void;
  const promise = new Promise<void>((res) => {
    done = res;
  });
  settledOf.set(r.ac, promise);
  pending.add(promise);
  return () => {
    // Only remove our own entry: a continuation may already have registered under the same task id.
    if (runs.get(taskId) === handle) runs.delete(taskId);
    pending.delete(promise);
    done();
  };
}

/** Live runs of a thread, oldest first. */
export function liveTasksOf(threadId: string): TaskRunHandle[] {
  return [...runs.values()].filter((h) => h.threadId === threadId).sort((a, b) => a.seq - b.seq);
}

/** One live run by task id, or undefined. */
export const taskRunOf = (taskId: string): TaskRunHandle | undefined => runs.get(taskId);

/**
 * The thread's live run as one controller: the foreground run holding the thread, else the newest task run of the
 * thread, else undefined. Busy lane, `/stop` and `/status` read the thread through it.
 */
export function liveRunOf(
  active: Map<string, AbortController>,
  threadId: string,
): AbortController | undefined {
  return active.get(threadId) ?? liveTasksOf(threadId).at(-1)?.ac;
}

/** Abort every live run of a thread; returns the handles that were aborted (the caller settles their rows). */
export function abortThreadTasks(threadId: string): TaskRunHandle[] {
  const live = liveTasksOf(threadId);
  for (const h of live) h.ac.abort();
  return live;
}

/** Abort every live run (graceful shutdown). */
export function abortAllTaskRuns(): void {
  for (const h of runs.values()) h.ac.abort();
}

/** Promises that resolve when each live run has settled (shutdown drain). */
export const pendingTaskRuns = (): Promise<void>[] => [...pending];

/** Resolves when the run that owned this controller has settled; undefined when it was not a registered task run. */
export const taskRunSettled = (ac: AbortController): Promise<void> | undefined => settledOf.get(ac);
