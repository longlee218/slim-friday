import type { Database } from "bun:sqlite";
import type { ApprovalGateway } from "../approvals/approval-types";
import type { AgentConfig } from "../config/agent-config";
import type { TaskClass } from "../config/model-routing";
import type { Task } from "../ingress/discord-message-handler";
import type { IntentDeps } from "../intent/decide-intent";
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
import { cleanupWorktree } from "../workspaces/clone-cleanup";
import { selectWorkspace } from "../workspaces/task-workspace";
import { createBusyLane } from "./busy-lane";
import type { DispatchDeps } from "./dispatch/dispatch-role";
import { routeAndRun } from "./route-and-run";
import type { RoleRunCtx } from "./run-turn";
import { parseTaskCommand } from "./task-commands";
import type { RunLimiter } from "./tasks/run-limiter";
import { createSteerRegistry } from "./tasks/steer-registry";
import { OUTCOME_REPLY } from "./tasks/task-result";
import {
  beginTask,
  createRunTracker,
  failTask,
  refused,
  renewActive,
  stopThread,
  taskLogContext,
} from "./tasks/task-tracker";
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
  /** Owner approval gateway; required for staged (gated) roles such as dev, and their worktree follow-ups. */
  approvals?: ApprovalGateway;
  /** Intent layer (pipeline + L3 engine), built at startup. Missing = off: every message takes the legacy pick (entry role / clone owner). */
  intent?: IntentDeps;
}

/** Build `handleTask`: Discord-free entry that owns the per-thread lock and `stop`. */
export function createTaskHandler(deps: TaskHandlerDeps) {
  const { db, config } = deps;
  /** threadId -> controller of the active run (one run per thread). */
  const active = new Map<string, AbortController>();
  const log = logger.child({ module: "handle-task" });
  const tracker = createRunTracker(db, log, active);
  const git = deps.git ?? createGitMcp();
  /** Per-thread effort floors; `quietTurn` runs every turn so entries decay (a complaint signal raises one). */
  const floors = new EffortFloors();
  /** What a role run and the dispatcher need; nothing in it changes per message. */
  const dispatchDeps: DispatchDeps = {
    db,
    config,
    approvals: deps.approvals!,
    queryFn: deps.queryFn,
    git,
    stopping: tracker.isStopping,
    threadBusy: (id) => active.has(id),
    steer: createSteerRegistry(db), // streaming stages take the owner's messages while they run
  };
  const busyLane = createBusyLane({
    deps: dispatchDeps,
    log,
    intent: deps.intent,
    floors,
    limiter: deps.limiter,
    active,
  });
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
    if (parsed.kind !== "task")
      logEvent(log, "intent.layer", { layer: "L0", ruleIds: [parsed.kind] });
    if (parsed.kind === "memory") return (await memory(task)) ?? ""; // owner memory command: no agent
    if (parsed.kind === "stop") {
      if (running) dispatchDeps.steer?.record(task, task.text, "stop"); // audit; stopThread aborts, the queue stays
      return stopThread(db, threadId, running);
    }
    // The run holds the thread: `still working...`, or (intent layer on) steer / side answer / queue / yes-no.
    if (running) return busyLane(task, parsed, running);
    if (parsed.kind === "cleanup")
      return cleanupWorktree({ db, agentHome: config.agentHome, active }, task, parsed.taskId);
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
    const begin = (
      repo: string,
      role: string,
      mode: string,
      cls?: TaskClass,
      parentTaskId?: string,
      resume?: boolean,
    ) => {
      beginTask(
        db,
        log,
        { taskId, threadId, source: task.source, single },
        { repo, role, mode, cls, parentTaskId, resume },
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
      // Everything a role run needs (the approval gateway exists whenever a staged role is routed).
      const rc: RoleRunCtx = {
        deps: dispatchDeps,
        log,
        task,
        taskId,
        t0,
        workspace: ws.name,
        repos,
        ac,
        begin,
        taskRepo,
      };
      return await routeAndRun({
        rc,
        parsed,
        stored,
        floors,
        intent: deps.intent,
        hasApprovals: !!deps.approvals,
        renewAc: () => renewActive(active, threadId), // the queue after a user `/stop`
      });
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
