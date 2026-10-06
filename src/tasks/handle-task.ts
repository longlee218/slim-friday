import type { Database } from "bun:sqlite";
import type { QueryFn } from "../agent/run-agent";
import { RESUME_FAILED } from "../agent/run-errors";
import type { ApprovalGateway } from "../approvals/approval-types";
import type { AgentConfig } from "../config/agent-config";
import { realOrSame } from "../guardrails/paths";
import type { Task } from "../ingress/discord-message-handler";
import { createGitMcp, type GitMcp } from "../mcp/git-mcp";
import { ensureHome } from "../memory/persona";
import {
  excerpt,
  getLogContext,
  logEvent,
  logger,
  runWithLogContext,
  setLogContext,
  tryLog,
} from "../observability/logger";
import { errText } from "../observability/redact";
import { loadRepoRegistry } from "../repos/repo-registry";
import { finishTask, insertTask, setTaskStatus } from "../storage/run-store";
import { deleteSession, getSession } from "../storage/session-store";
import { runCodeFlow } from "./code-task-flow";
import { runQaFlow } from "./qa-flow";
import type { RunLimiter } from "./run-limiter";
import { parseTaskCommand } from "./task-commands";
import type { FlowResult } from "./task-result";
import { finishRun, OUTCOME_REPLY } from "./task-result";
import { resolveCommand, routeTask } from "./task-routing";
import { createRunTracker } from "./task-tracker";
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

/** Build `handleTask`: Discord-free entry that owns the per-thread lock and `stop`. */
export function createTaskHandler(deps: TaskHandlerDeps) {
  const { db, config } = deps;
  /** threadId -> controller of the active run (one run per thread). */
  const active = new Map<string, AbortController>();
  const log = logger.child({ module: "handle-task" });
  const tracker = createRunTracker(db, log, active);
  const git = deps.git ?? createGitMcp();

  /** Handle one task and return the (redacted) reply text. */
  const run = async (task: Task): Promise<string> => {
    const { threadId } = task;
    const running = active.get(threadId);
    const parsed = parseTaskCommand(task.text);
    const t0 = Date.now();
    logEvent(log, "task.routed", {
      kind: parsed.kind,
      repoHint: "repo" in parsed ? (parsed.repo ?? null) : null,
    });

    // `stop` aborts the active run; the running call marks the task cancelled.
    if (parsed.kind === "stop") {
      if (!running) return "Nothing is running.";
      running.abort();
      return "Stopping...";
    }
    if (running) {
      logEvent(log, "task.still_working");
      return "still working...";
    }
    if (parsed.kind === "cleanup")
      return cleanupWorktree({ db, git, inUse: (t) => active.has(t) }, threadId, parsed.taskId);
    // Global cap is checked after stop/still-working so those always answer.
    const release = deps.limiter ? deps.limiter.tryAcquire() : () => {};
    if (!release) {
      logEvent(log, "task.busy", { reason: "run_limit", active: deps.limiter!.active() });
      return `busy, ${deps.limiter!.active()} runs active, try again in a minute`;
    }

    const ac = new AbortController();
    active.set(threadId, ac);
    const taskId = crypto.randomUUID();
    // From here every log line of this task (any module) carries taskId; repo/mode are set below.
    setLogContext({ taskId });
    let taskInserted = false;
    /** Repo of the log context ("*" = not chosen yet); follows later setLogContext (tool-hooks). */
    const taskRepo = () => getLogContext().repo ?? "*";
    /** The one place a task row is created (after the refusals, before the flow runs). */
    let single: string | undefined;
    const begin = (repo: string, type: "qa" | "code", mode: string) => {
      insertTask(db, { id: taskId, threadId, source: task.source, repo, type });
      taskInserted = true;
      // Unpinned task with a single workspace: that workspace is the log repo (row keeps "*").
      // Lines logged before the repo is known (message.received, task.started with "*") stay in the
      // main log only; tool-hooks sets the repo later for unpinned multi-repo tasks.
      const logRepo = repo === "*" && single ? single : repo;
      setLogContext({ repo: logRepo, mode });
      logEvent(log, "task.started", { repo: logRepo, type });
    };
    // Everything after the lock is taken lives in try so `finally` always releases it.
    try {
      const stored = getSession(db, threadId);
      // Registry is re-read per task so config.yaml edits apply without a restart.
      const repos = loadRepoRegistry(config.agentHome);
      single = repos.length === 1 ? repos[0]!.name : undefined;
      ensureHome(config.agentHome, repos); // create missing IDENTITY/MEMORY/logs/links (never overwrites)
      if (repos.length === 0) {
        const reply = `No workspace found. Add workspaces/<name>/config.yaml under ${config.agentHome}.`;
        logEvent(log, "task.refused", { reason: "no_workspace", reply });
        return reply;
      }
      // Resume button becomes a follow-up / plan run / Q&A from the interrupted task's session (or a refusal).
      const resolved = resolveCommand({ db, agentHome: config.agentHome, repos }, parsed, threadId);
      if ("reply" in resolved) {
        logEvent(log, "task.refused", { reason: resolved.reason, reply: resolved.reply });
        return resolved.reply;
      }
      const { cmd, planResume } = resolved;
      const existing = resolved.existing ?? stored;
      const route = routeTask(
        { db, agentHome: config.agentHome, hasApprovals: !!deps.approvals },
        { cmd, threadId, repos, existing },
      );
      if ("reply" in route) {
        logEvent(log, route.event, { reason: route.reason, reply: route.reply });
        return route.reply;
      }
      const { pinned, worktree, isCode } = route;
      begin(route.repo, isCode ? "code" : "qa", !isCode ? "qa" : worktree ? "exec" : "plan");
      const res: FlowResult = isCode
        ? await runCodeFlow(
            { db, config, approvals: deps.approvals!, queryFn: deps.queryFn, git },
            {
              taskId,
              threadId,
              text: cmd.text,
              repos: route.candidates,
              ac,
              worktree,
              planResume,
              resume:
                worktree && existing?.cwd === realOrSame(worktree.path)
                  ? existing.session_id
                  : undefined,
            },
          )
        : await runQaFlow(
            { db, config, git, queryFn: deps.queryFn },
            { taskId, text: cmd.text, repos, pinned, existing, ac },
          );
      const reply = finishRun(db, { taskId, threadId }, res);
      if (tracker.isStopping() && res.outcome === "aborted")
        setTaskStatus(db, taskId, "interrupted");
      logEvent(log, "task.finished", {
        repo: res.repo && res.repo !== "*" ? res.repo : taskRepo(),
        outcome: res.outcome,
        durationMs: Date.now() - t0,
        reply: excerpt(reply),
      });
      // Genuine resume failure only: drop the stale session. Transient errors keep it (and the prompt).
      if (res.outcome === "error" && RESUME_FAILED.test(res.text)) {
        // The plan session lives on the task row (the failed task now has none, so Resume stops offering it).
        if (planResume) return "Could not resume the plan; start the task again.";
        if (isCode || !existing) return reply;
        deleteSession(db, threadId);
        return "Could not resume the previous session; it was cleared. Please send your message again.";
      }
      return reply;
    } catch (err) {
      // Never throw from the error path (db may be closed during shutdown).
      if (taskInserted) tryLog(log, "finishTask failed", () => finishTask(db, taskId, "failed"));
      logEvent(
        log,
        "task.finished",
        { repo: taskRepo(), outcome: "crashed", durationMs: Date.now() - t0, err: errText(err) },
        "error",
      );
      return OUTCOME_REPLY.error!;
    } finally {
      active.delete(threadId);
      release();
    }
  };
  const handleTask = (task: Task): Promise<string> =>
    // Every line logged while this call runs (any module, any await) carries the thread id.
    tracker.track(runWithLogContext({ threadId: task.threadId }, () => run(task)));
  /** Stop the git MCP server process (shutdown). */
  handleTask.close = () => git.close();
  handleTask.abortAll = tracker.abortAll;
  handleTask.drain = tracker.drain;
  return handleTask;
}
