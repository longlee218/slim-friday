import type { Database } from "bun:sqlite";
import { type QueryFn, runAgent } from "../agent/run-agent";
import type { AgentConfig } from "../config/agent-config";
import { isStop } from "../ingress/discord-message-rules";
import type { Task } from "../ingress/task-types";
import { logger } from "../observability/logger";
import { redactText } from "../observability/redact";
import { cancelRunningTasks, finishTask, insertTask, type TaskStatus } from "../storage/run-store";
import { deleteSession, getSession, setSession } from "../storage/session-store";
import type { RunLimiter } from "./run-limiter";

/** Dependencies of the task handler. */
export interface TaskHandlerDeps {
  db: Database;
  config: AgentConfig;
  /** Override the SDK query (tests). */
  queryFn?: QueryFn;
  /** Optional global concurrency cap; when full the task is rejected with a busy reply. */
  limiter?: RunLimiter;
}

/** Map run outcome to the user-facing reply when there is no answer text. */
const OUTCOME_REPLY: Record<string, string> = {
  max_turns: "Stopped: reached the turn limit.",
  max_budget: "Stopped: reached the budget limit.",
  timeout: "Stopped: timed out.",
  aborted: "Stopped.",
  error: "Agent failed. Check the logs.",
};

/** Map run outcome to the task status stored in db. */
const TASK_STATUS: Record<string, TaskStatus> = {
  success: "done",
  aborted: "cancelled",
  timeout: "timeout",
};

/** Outcomes where a result message arrived, so the session transcript exists and can be resumed. */
const SAVE_SESSION_OUTCOMES = new Set(["success", "max_turns", "max_budget"]);

/** Error text of a failed `resume` (session transcript missing); only then is the stored session dropped. */
const RESUME_FAILED =
  /no conversation found|could not resume|session .*(not found|does not exist)/i;

/** Build `handleTask`: Discord-free entry that owns the per-thread lock and `stop`. */
export function createTaskHandler(deps: TaskHandlerDeps) {
  /** threadId -> controller of the active run (one run per thread). */
  const active = new Map<string, AbortController>();
  const log = logger.child({ module: "handle-task" });

  /** Handle one task and return the (redacted) reply text. */
  const run = async (task: Task): Promise<string> => {
    const { threadId } = task;
    const running = active.get(threadId);

    // `stop` aborts the active run; the running call marks the task cancelled.
    if (isStop(task.text)) {
      if (!running) return "Nothing is running.";
      running.abort();
      return "Stopping...";
    }
    if (running) return "still working...";
    // Global cap is checked after stop/still-working so those always answer.
    const release = deps.limiter ? deps.limiter.tryAcquire() : () => {};
    if (!release) return `busy, ${deps.limiter!.active()} runs active, try again in a minute`;

    const ac = new AbortController();
    active.set(threadId, ac);
    const taskId = crypto.randomUUID();
    const tlog = log.child({ taskId, threadId });
    let taskInserted = false;

    // Everything after the lock is taken lives in try so `finally` always releases it.
    try {
      const existing = getSession(deps.db, threadId);
      const cwd = existing?.cwd ?? deps.config.defaultRepoPath;
      insertTask(deps.db, { id: taskId, threadId, source: task.source, repo: cwd, type: "qa" });
      taskInserted = true;
      const res = await runAgent({
        prompt: task.text,
        taskId,
        cwd,
        resume: existing?.session_id,
        config: deps.config,
        db: deps.db,
        abortController: ac,
        queryFn: deps.queryFn,
      });
      // Only outcomes that produced a result message have a persisted transcript worth resuming.
      if (res.sessionId && SAVE_SESSION_OUTCOMES.has(res.outcome)) {
        setSession(deps.db, { threadId, sessionId: res.sessionId, repo: cwd, cwd });
      }
      finishTask(deps.db, taskId, TASK_STATUS[res.outcome] ?? "failed");
      tlog.info({ outcome: res.outcome }, "task finished");
      // Genuine resume failure only: drop the stale session. Transient errors keep it (and the prompt).
      if (res.outcome === "error" && existing && RESUME_FAILED.test(res.text)) {
        deleteSession(deps.db, threadId);
        return "Could not resume the previous session; it was cleared. Please send your message again.";
      }
      return redactText(res.text || OUTCOME_REPLY[res.outcome] || "No answer.");
    } catch (err) {
      // Never throw from the error path (db may be closed during shutdown).
      if (taskInserted) {
        try {
          finishTask(deps.db, taskId, "failed");
        } catch (e) {
          tlog.error({ err: redactText(String(e)) }, "finishTask failed");
        }
      }
      tlog.error({ err: redactText(String(err)) }, "task crashed");
      return OUTCOME_REPLY.error!;
    } finally {
      active.delete(threadId);
      release();
    }
  };
  /** Promises of calls in flight, so shutdown can wait for them. */
  const inflight = new Set<Promise<string>>();
  /** Track the call until it settles (`run` never rejects). */
  const handleTask = (task: Task): Promise<string> => {
    const p = run(task);
    inflight.add(p);
    const done = () => {
      inflight.delete(p);
    };
    p.then(done, done);
    return p;
  };
  /** Abort every active run (graceful shutdown). */
  handleTask.abortAll = () => {
    for (const ac of active.values()) ac.abort();
  };
  /** Abort all runs, wait up to `timeoutMs` for them to finish, then mark leftovers cancelled. */
  handleTask.drain = async (timeoutMs: number): Promise<void> => {
    handleTask.abortAll();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    });
    await Promise.race([Promise.allSettled([...inflight]), timeout]);
    clearTimeout(timer);
    try {
      cancelRunningTasks(deps.db);
    } catch (e) {
      log.error({ err: redactText(String(e)) }, "cancelRunningTasks failed");
    }
  };
  return handleTask;
}
