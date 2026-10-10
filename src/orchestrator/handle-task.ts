import type { Database } from "bun:sqlite";
import type { ApprovalGateway } from "../approvals/approval-types";
import type { AgentConfig } from "../config/agent-config";
import type { TaskClass } from "../config/model-routing";
import type { Task } from "../ingress/discord-message-handler";
import { DRAIN_REPLY, isDraining } from "../lifecycle/drain";
import { createGitMcp, type GitMcp } from "../mcp/git-mcp";
import { createMemoryRunner } from "../memory/memory-command-handler";
import {
  getLogContext,
  logEvent,
  logger,
  runWithLogContext,
  setLogContext,
} from "../observability/logger";
import { errText } from "../observability/redact";
import type { QueryFn } from "../runtime/run-agent";
import { getSession } from "../storage/session-store";
import { selectWorkspace } from "../workspaces/task-workspace";
import { PROPOSAL_EXPIRED_REPLY, pendingProposalFor } from "./dispatch/proposal-flow";
import { startPendingProposal } from "./dispatch/start-proposal";
import { delegateCheck } from "./dispatch/validate-request";
import { type RoleRunCtx, runTurn } from "./run-turn";
import { parseTaskCommand } from "./task-commands";
import { PLAIN_GO, resolveCommand, routeTask } from "./task-routing";
import type { RunLimiter } from "./tasks/run-limiter";
import { OUTCOME_REPLY } from "./tasks/task-result";
import {
  beginTask,
  createRunTracker,
  failTask,
  refused,
  taskLogContext,
} from "./tasks/task-tracker";
import { cleanupWorktree } from "./tasks/task-worktree";
import { EffortFloors } from "./thread/effort-floor";

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
  /** Owner approval gateway; required for code tasks (the `DelegateTask` tool, worktree follow-ups). */
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
  /** Per-thread effort floors; `quietTurn` runs every turn so entries decay (nothing raises one until P1.4c). */
  const floors = new EffortFloors();
  const memory = createMemoryRunner({ db, config, queryFn: deps.queryFn, limiter: deps.limiter });
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
    if (parsed.kind === "memory") return (await memory(task)) ?? ""; // owner memory command: no agent
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
    // Drain (deploy): no new task starts; stop / still-working / cleanup above still answer.
    if (isDraining(config.agentHome)) {
      logEvent(log, "task.refused", { reason: "drain", reply: DRAIN_REPLY });
      return DRAIN_REPLY;
    }
    // Global cap is checked after stop/still-working so those always answer.
    const release = deps.limiter ? deps.limiter.tryAcquire() : () => {};
    if (!release) {
      logEvent(log, "task.busy", { reason: "run_limit", active: deps.limiter!.active() });
      return `busy, ${deps.limiter!.active()} runs active, try again in a minute`;
    }
    floors.quietTurn(threadId);
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
    const begin = (repo: string, role: string, mode: string, cls?: TaskClass) => {
      beginTask(
        db,
        log,
        { taskId, threadId, source: task.source, single },
        { repo, role, mode, cls },
      );
      taskInserted = true;
    };
    // Everything after the lock is taken lives in try so `finally` always releases it.
    try {
      const stored = getSession(db, threadId);
      const picked = selectWorkspace(config.agentHome, task.channelId);
      if ("reply" in picked) return refused(log, picked);
      const { ws } = picked;
      const { repos } = ws; // every repo lookup below stays inside this workspace
      setLogContext({ workspace: ws.name });
      single = repos.length === 1 ? repos[0]!.name : undefined;
      // Everything a role run needs (the approval gateway exists whenever a code task is routed).
      const rc: RoleRunCtx = {
        deps: {
          db,
          config,
          approvals: deps.approvals!,
          queryFn: deps.queryFn,
          git,
          stopping: tracker.isStopping,
          delegateCheck: (p) => delegateCheck({ db, agentHome: config.agentHome, ...p }),
        },
        log,
        task,
        taskId,
        t0,
        workspace: ws.name,
        repos,
        ac,
        allowDelegate: !!deps.approvals, // handoff only when the next role can be approved
        begin,
        taskRepo,
      };
      // `go` starts the thread's pending proposal (it survived a restart), else it resumes like the button.
      const pending = parsed.kind === "go" ? pendingProposalFor(db, threadId, ws.name) : null;
      if (pending === "expired") return PROPOSAL_EXPIRED_REPLY;
      if (parsed.kind === "go" && pending) {
        const pinned = repos.find((r) => r.name === stored?.repo);
        return await startPendingProposal({ ...rc, pinned }, pending, parsed.extraBudgetUsd);
      }
      let extraBudgetUsd = "extraBudgetUsd" in parsed ? parsed.extraBudgetUsd : undefined;
      const input = parsed.kind === "go" ? { kind: "resume" as const, extraBudgetUsd } : parsed;
      // Resume button becomes a follow-up / plan run / Q&A from the interrupted task's session (or a refusal).
      const rdeps = { db, agentHome: config.agentHome, workspace: ws.name, repos };
      let resolved = resolveCommand(rdeps, input, threadId);
      // `go` with nothing to start or resume is an ordinary message (e.g. "go" as a follow-up in a worktree).
      if (parsed.kind === "go" && "reply" in resolved && PLAIN_GO.has(resolved.reason)) {
        resolved = resolveCommand(rdeps, { kind: "task", text: task.text.trim() }, threadId);
        extraBudgetUsd = undefined; // the raise belongs to a resume, not a plain message
      }
      if ("reply" in resolved) return refused(log, resolved);
      const route = routeTask(
        { db, agentHome: config.agentHome, hasApprovals: !!deps.approvals },
        { cmd: resolved.cmd, threadId, repos, existing: resolved.existing ?? stored },
      );
      if ("reply" in route) {
        logEvent(log, route.event, { reason: route.reason, reply: route.reply });
        return route.reply;
      }
      return await runTurn(rc, { route, plan: resolved, existing: stored, extraBudgetUsd });
    } catch (err) {
      // Never throw from the error path (db may be closed during shutdown).
      if (taskInserted) failTask(db, log, taskId);
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
    // Every line logged while this call runs (any module, any await) carries the thread id and channel id.
    tracker.track(runWithLogContext(taskLogContext(task), () => run(task)));
  /** Stop the git MCP server process (shutdown). */
  handleTask.close = () => git.close();
  handleTask.memory = memory; // same runner for ingress (inline channel replies, #ops-control)
  handleTask.abortAll = tracker.abortAll;
  handleTask.drain = tracker.drain;
  return handleTask;
}
