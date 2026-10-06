import type { Database } from "bun:sqlite";
import type { QueryFn } from "../agent/run-agent";
import type { ApprovalGateway } from "../approvals/approval-types";
import type { AgentConfig } from "../config/agent-config";
import { realOrSame } from "../guardrails/paths";
import type { Task } from "../ingress/discord-message-handler";
import { createGitMcp, type GitMcp } from "../mcp/git-mcp";
import { ensureHome } from "../memory/persona";
import { logger, tryLog } from "../observability/logger";
import { errText } from "../observability/redact";
import { isManagedClone } from "../repos/refresh-repo";
import { loadRepoRegistry } from "../repos/repo-registry";
import {
  cancelRunningTasks,
  countActiveCodeTasks,
  finishTask,
  insertTask,
} from "../storage/run-store";
import { deleteSession, getSession } from "../storage/session-store";
import { liveWorktree } from "../storage/worktree-store";
import { runCodeFlow } from "./code-task-flow";
import { runQaFlow } from "./qa-flow";
import type { RunLimiter } from "./run-limiter";
import { parseTaskCommand } from "./task-commands";
import type { FlowResult } from "./task-result";
import { finishRun, OUTCOME_REPLY, RESUME_FAILED } from "./task-result";
import { cleanupWorktree } from "./task-worktree";

/** Dependencies of the task handler. */
export interface TaskHandlerDeps {
  db: Database;
  config: AgentConfig;
  /** Override the SDK query (tests). */
  queryFn?: QueryFn;
  /** Optional global concurrency cap; when full the task is rejected with a busy reply. */
  limiter?: RunLimiter;
  /** The git MCP server the app uses (worktrees, fetch, push, inspection); started on first use. */
  git?: GitMcp;
  /** Owner approval gateway; required for `task:` code tasks. */
  approvals?: ApprovalGateway;
}

/** Max code tasks running or waiting for approval at once (RAM/quota; spike Q12). */
const MAX_CODE_TASKS = 2;

/** Build `handleTask`: Discord-free entry that owns the per-thread lock and `stop`. */
export function createTaskHandler(deps: TaskHandlerDeps) {
  const { db, config } = deps;
  /** threadId -> controller of the active run (one run per thread). */
  const active = new Map<string, AbortController>();
  const log = logger.child({ module: "handle-task" });
  const git = deps.git ?? createGitMcp();

  /** Handle one task and return the (redacted) reply text. */
  const run = async (task: Task): Promise<string> => {
    const { threadId } = task;
    const running = active.get(threadId);
    const cmd = parseTaskCommand(task.text);

    // `stop` aborts the active run; the running call marks the task cancelled.
    if (cmd.kind === "stop") {
      if (!running) return "Nothing is running.";
      running.abort();
      return "Stopping...";
    }
    if (running) return "still working...";
    if (cmd.kind === "cleanup")
      return cleanupWorktree({ db, git, log, inUse: (t) => active.has(t) }, threadId, cmd.taskId);
    // Global cap is checked after stop/still-working so those always answer.
    const release = deps.limiter ? deps.limiter.tryAcquire() : () => {};
    if (!release) return `busy, ${deps.limiter!.active()} runs active, try again in a minute`;

    const ac = new AbortController();
    active.set(threadId, ac);
    const taskId = crypto.randomUUID();
    const tlog = log.child({ taskId, threadId });
    let taskInserted = false;
    /** The one place a task row is created (after the refusals, before the flow runs). */
    const begin = (repo: string, type: "qa" | "code") => {
      insertTask(db, { id: taskId, threadId, source: task.source, repo, type });
      taskInserted = true;
    };

    // Everything after the lock is taken lives in try so `finally` always releases it.
    try {
      const existing = getSession(db, threadId);
      // Registry is re-read per task so config.yaml edits apply without a restart.
      const repos = loadRepoRegistry(config.agentHome);
      ensureHome(config.agentHome, repos); // create missing IDENTITY/MEMORY/logs/links (never overwrites)
      if (repos.length === 0) {
        return `No workspace found. Add workspaces/<name>/config.yaml under ${config.agentHome}.`;
      }
      const hint = cmd.repo?.toLowerCase();
      const pinned = hint
        ? repos.find((r) => r.name.toLowerCase() === hint)
        : repos.find((r) => r.name === existing?.repo); // thread stays on its pinned repo
      if (cmd.repo && !pinned) {
        return `Unknown repo "${cmd.repo}". Available: ${repos.map((r) => r.name).join(", ")}`;
      }
      if (cmd.repo && !cmd.text) return `Send your question after "repo:${pinned!.name}".`;
      // Code task (`task:`) or follow-up in a thread that already has a worktree.
      const worktree = cmd.kind === "code" ? undefined : liveWorktree(db, threadId);
      const isCode = cmd.kind === "code" || !!worktree;
      if (isCode && !deps.approvals) return "Code tasks need the Discord approval flow.";
      if (isCode && !cmd.text) return "Send the task after `task:`.";

      let res: FlowResult;
      if (isCode) {
        // Worktrees branch off managed clones only, never a developer's working copy.
        // `repo:` is a hint for a task; there is no sticky pin.
        const picked = cmd.repo ? pinned : undefined;
        const candidates = (picked ? [picked] : repos).filter((r) =>
          isManagedClone(r.path, config.agentHome),
        );
        if (!worktree && candidates.length === 0) {
          return "Code tasks need a workspace clone (workspaces/<name>/repo with a config.yaml). Clone the repo there first.";
        }
        if (countActiveCodeTasks(db) >= MAX_CODE_TASKS) {
          return `busy, ${MAX_CODE_TASKS} code tasks running, try again later`;
        }
        begin(worktree?.repo ?? picked?.name ?? "*", "code");
        res = await runCodeFlow(
          { db, config, approvals: deps.approvals!, queryFn: deps.queryFn, git },
          {
            taskId,
            threadId,
            text: cmd.text,
            repos: worktree ? repos : candidates,
            ac,
            worktree,
            resume:
              worktree && existing?.cwd === realOrSame(worktree.path)
                ? existing.session_id
                : undefined,
          },
        );
      } else {
        begin(pinned?.name ?? "*", "qa");
        res = await runQaFlow(
          { db, config, git, queryFn: deps.queryFn },
          { taskId, text: cmd.text, repos, pinned, existing, ac },
        );
      }
      const reply = finishRun(db, tlog, { taskId, threadId }, res);
      // Genuine resume failure only: drop the stale session. Transient errors keep it (and the prompt).
      if (!isCode && res.outcome === "error" && existing && RESUME_FAILED.test(res.text)) {
        deleteSession(db, threadId);
        return "Could not resume the previous session; it was cleared. Please send your message again.";
      }
      return reply;
    } catch (err) {
      // Never throw from the error path (db may be closed during shutdown).
      if (taskInserted) tryLog(tlog, "finishTask failed", () => finishTask(db, taskId, "failed"));
      tlog.error({ err: errText(err) }, "task crashed");
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
  /** Stop the git MCP server process (shutdown). */
  handleTask.close = () => git.close();
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
    tryLog(log, "cancelRunningTasks failed", () => cancelRunningTasks(db));
  };
  return handleTask;
}
