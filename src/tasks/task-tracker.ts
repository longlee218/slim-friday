import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { tryLog } from "../observability/logger";
import { interruptRunningTasks } from "../storage/run-store";

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
      tryLog(log, "interruptRunningTasks failed", () => interruptRunningTasks(db));
    },
  };
}
