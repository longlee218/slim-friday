import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { logEvent, setLogContext, tryLog } from "../observability/logger";
import { finishTask, insertTask, interruptRunningTasks } from "../storage/run-store";

/** Log-context fields every line of a call carries: its thread and its routing channel. */
export const taskLogContext = (t: { threadId: string; channelId: string }) => ({
  threadId: t.threadId,
  channelId: t.channelId,
});

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

/**
 * Create the task row (`brief` = the delegated code task's prompt) and set the log context of the task (repo, mode). `single` = the only registered
 * workspace: an unpinned task ("*" row) then logs under it. Lines logged before the repo is known
 * (message.received, task.started with "*") stay in the main log only; tool-hooks sets the repo later
 * for unpinned multi-repo tasks.
 */
export function beginTask(
  db: Database,
  log: Logger,
  ids: { taskId: string; threadId: string; source: string; single?: string },
  t: { repo: string; type: "qa" | "code"; mode: string; brief?: string },
): void {
  insertTask(db, {
    id: ids.taskId,
    threadId: ids.threadId,
    source: ids.source,
    repo: t.repo,
    type: t.type,
    brief: t.brief,
  });
  const logRepo = t.repo === "*" && ids.single ? ids.single : t.repo;
  setLogContext({ repo: logRepo, mode: t.mode });
  logEvent(log, "task.started", { repo: logRepo, type: t.type });
}

/** Log a refused task (`task.refused`) and return the reply text for the owner. */
export function refused(log: Logger, r: { reason: string; reply: string }): string {
  logEvent(log, "task.refused", { reason: r.reason, reply: r.reply });
  return r.reply;
}

/** Mark a task row `failed` on a crash path. Never throws (the db may be closed during shutdown). */
export function failTask(db: Database, log: Logger, taskId: string): void {
  tryLog(log, "finishTask failed", () => finishTask(db, taskId, "failed"));
}
