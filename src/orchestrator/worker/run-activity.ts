import type { Database } from "bun:sqlite";
import { ACTIVITY_PERSIST_MS } from "../../config/resilience-caps";
import { redactClip } from "../../observability/redact";
import { touchProgress } from "../../storage/owned-task-store";
import { PROGRESS_NOTE_MAX_CHARS } from "../lead/lead-limits";
import { type LiveRun, runOfTask } from "../run/live-runs";

/* Activity of a worker run, kept on its live-run entry: the watchdog's heartbeat and the `Report` progress facts.
   The in-memory stamp is always fresh; the db stamp (`owned_tasks.last_progress_at`, no schema change) is written at
   most once per `ACTIVITY_PERSIST_MS` so a tool-heavy run does not write on every call. A run that is not live (or
   is the lead's) is ignored: nothing here throws. */

/** The live worker run of a task id or turn id, or undefined. */
const workerOf = (idOrTurn: string): LiveRun | undefined => {
  const run = runOfTask(idOrTurn);
  return run?.kind === "worker" ? run : undefined;
};

/** Sign of life: stamp the run now, and persist it when the last db write is older than the throttle. */
export function touch(db: Database, idOrTurn: string, now = Date.now()): void {
  const run = workerOf(idOrTurn);
  if (!run) return;
  run.lastActivityAt = now;
  if (run.taskId && now - (run.persistedAt ?? 0) >= ACTIVITY_PERSIST_MS) {
    run.persistedAt = now;
    touchProgress(db, run.taskId, now);
  }
}

/** `Report` progress: record percent + note (redacted, clipped here) and count it as a sign of life. */
export function setProgress(
  db: Database,
  idOrTurn: string,
  p: { percent: number; note: string },
  now = Date.now(),
): void {
  const run = workerOf(idOrTurn);
  if (!run) return;
  run.progress = {
    percent: Math.min(100, Math.max(0, Math.round(p.percent))),
    note: redactClip(p.note.replace(/\s+/g, " ").trim(), PROGRESS_NOTE_MAX_CHARS),
    at: now,
  };
  touch(db, idOrTurn, now);
}

/**
 * Open (`true`) or close (`false`) one by-design wait of the run on the owner / lead; the watchdog skips the run while
 * any wait is open (a counter: parallel waits do not cancel each other). Closing the LAST wait counts as activity.
 */
export function setWaiting(db: Database, idOrTurn: string, waiting: boolean): void {
  const run = workerOf(idOrTurn);
  if (!run) return;
  run.waitingCount = Math.max(0, (run.waitingCount ?? 0) + (waiting ? 1 : -1));
  if (!waiting && run.waitingCount === 0) touch(db, idOrTurn);
}

/** Run `fn` as one by-design wait of the run: opened before, closed in `finally` (also when `fn` throws). */
export async function withWaiting<T>(
  db: Database,
  idOrTurn: string,
  fn: () => Promise<T>,
): Promise<T> {
  setWaiting(db, idOrTurn, true);
  try {
    return await fn();
  } finally {
    setWaiting(db, idOrTurn, false);
  }
}

/** Progress + idle seconds of a live worker run (by task id or turn id), or undefined when it is not live. */
export function progressOf(
  idOrTurn: string,
  now = Date.now(),
): { percent?: number; note?: string; idleSeconds: number } | undefined {
  const run = workerOf(idOrTurn);
  if (!run) return undefined;
  return {
    ...(run.progress && { percent: run.progress.percent, note: run.progress.note }),
    idleSeconds: Math.max(0, Math.round((now - run.lastActivityAt) / 1000)),
  };
}
