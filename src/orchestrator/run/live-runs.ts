/*
 * The ONE registry of the agent runs alive in this process: the lead run of a thread and every detached worker run.
 * A run registers when it starts (with its abort handle, thread, turn / task and role) and unregisters in its own
 * `finally`. A streaming worker also attaches its steer input sink to its entry. `/stop`, `/status`, steering and the
 * shutdown drain all reach a run through here, whatever thread lock it holds.
 */

import { logEvent, logger } from "../../observability/logger";
import type { SteerRun, SteerSink } from "../../runtime/run-input-channel";

/** Logger of this module. */
const log = logger.child({ module: "live-runs" });

/** `lead` = the thread's foreground run (one at a time); `worker` = a detached task run (several per thread). */
export type RunKind = "lead" | "worker";

/** What the registry knows about one live run. */
export interface LiveRun {
  /** Registry key: the owned task id of a worker, `lead:<threadId>` of a lead run. */
  key: string;
  kind: RunKind;
  threadId: string;
  /** Turn row of the run; unknown for a lead run at registration time (its turn is created inside the run). */
  turnId?: string;
  /** Owned task of a worker run. */
  taskId?: string;
  role: string;
  /** The run's own controller: aborting it stops the run. */
  ac: AbortController;
  /** Registration order (newest = highest). */
  seq: number;
  /** Input of a streaming run, once it registered it (owner steers are pushed into it). */
  steer?: { sink: SteerSink; run: SteerRun };
  /** Last sign of life (ms epoch): run start, every tool start, every `ReportProgress`. The watchdog reads it. */
  lastActivityAt: number;
  /** Last time the activity was written to the db (throttles `touchProgress`). */
  persistedAt?: number;
  /** Latest `ReportProgress` of a worker (in memory only: lost on a restart, harmless). */
  progress?: { percent: number; note: string; at: number };
  /** Open by-design waits of the run on the owner or the lead (question relay, effect confirms); the watchdog skips the run while it is above 0. */
  waitingCount?: number;
  /** Why the app (not the owner) aborted the run; set before `ac.abort()` so the run's end can tell the cause. */
  abortCause?: "stale" | "item_age";
}

/** key -> live run. */
const runs = new Map<string, LiveRun>();
/** Promises of the live runs (the shutdown drain waits on them). */
const pending = new Set<Promise<void>>();
let nextSeq = 0;

/**
 * Register a live run and return its `settle` function (idempotent; call it in the run's `finally`, also on
 * error / abort). A worker whose task id is already live means two runs of one task: the old run is aborted
 * (and logged) before the new one replaces its entry.
 */
export function registerRun(r: {
  kind: RunKind;
  threadId: string;
  role: string;
  ac: AbortController;
  turnId?: string;
  taskId?: string;
}): () => void {
  const workerKey = r.taskId ?? r.turnId;
  // A worker without an id would share one key with every other such worker: fail loudly instead.
  if (r.kind === "worker" && !workerKey)
    throw new Error("registerRun: a worker needs a taskId or turnId");
  const key = r.kind === "lead" ? `lead:${r.threadId}` : (workerKey as string);
  const old = runs.get(key);
  if (old && r.kind === "worker") {
    logEvent(log, "task_run.replaced", { key, oldTurnId: old.turnId, turnId: r.turnId }, "warn");
    old.ac.abort();
  }
  const run: LiveRun = { key, ...r, seq: nextSeq++, lastActivityAt: Date.now() };
  runs.set(key, run);
  let done!: () => void;
  const promise = new Promise<void>((res) => {
    done = res;
  });
  pending.add(promise);
  return () => {
    // Only remove our own entry: a continuation may already have registered under the same key.
    if (runs.get(key) === run) runs.delete(key);
    pending.delete(promise);
    done();
  };
}

/** Live runs of a thread, oldest first (the lead run included). */
export function liveRunsOf(threadId: string): LiveRun[] {
  return [...runs.values()].filter((h) => h.threadId === threadId).sort((a, b) => a.seq - b.seq);
}

/** Every live worker run (the watchdog's candidates; the lead run is never one). */
export const liveWorkers = (): LiveRun[] => [...runs.values()].filter((h) => h.kind === "worker");

/** One live worker run by owned task id or by turn id, or undefined. */
export const runOfTask = (idOrTurn: string): LiveRun | undefined =>
  runs.get(idOrTurn) ?? [...runs.values()].find((h) => h.turnId === idOrTurn);

/**
 * The thread's live run as one controller: the lead run holding the thread, else the newest worker run, else
 * undefined. Busy lane and `/stop` read the thread through it.
 */
export function liveRunOf(threadId: string): AbortController | undefined {
  return (runs.get(`lead:${threadId}`) ?? liveRunsOf(threadId).at(-1))?.ac;
}

/** Abort every live run of a thread (lead and workers); returns the runs that were aborted (the caller settles their rows). */
export function abortThreadRuns(threadId: string): LiveRun[] {
  const live = liveRunsOf(threadId);
  for (const h of live) h.ac.abort();
  return live;
}

/** Abort every live run (graceful shutdown). */
export function abortAllRuns(): void {
  for (const h of runs.values()) h.ac.abort();
}

/** Promises that resolve when each live run has settled (shutdown drain). */
export const pendingRuns = (): Promise<void>[] => [...pending];

/**
 * Attach the input sink of a streaming run to its live entry (found by turn id); returns the detach function.
 * A run that is not registered has no entry: nothing is attached and steers for it are held or refused.
 */
export function attachSink(turnId: string, sink: SteerSink, steerRun: SteerRun): () => void {
  const run = [...runs.values()].find((h) => h.turnId === turnId);
  if (!run) {
    logEvent(log, "steer.no_live_run", { turnId }, "warn");
    return () => {};
  }
  run.steer = { sink, run: steerRun };
  // Only detach our own sink: a later run of the same entry may have attached its own.
  return () => {
    if (run.steer?.sink === sink) run.steer = undefined;
  };
}

/** The input of the thread's newest live run that has one (the run steers of the thread are matched to), or undefined. */
export const steerRunOfThread = (threadId: string): SteerRun | undefined =>
  liveRunsOf(threadId)
    .filter((h) => h.steer)
    .at(-1)?.steer?.run;
