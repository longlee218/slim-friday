import type { Logger } from "pino";
import type { TaskClass } from "../config/model-routing";
import { realOrSame } from "../guardrails/paths";
import type { Task } from "../ingress/discord-message-handler";
import { logEvent } from "../observability/logger";
import type { Repo } from "../repos/repo-registry";
import { getRole } from "../roles/role-registry";
import { RESUME_FAILED } from "../runtime/run-errors";
import { threadLedger } from "../storage/ledger-store";
import { deleteSession, type SessionRow } from "../storage/session-store";
import { type DispatchDeps, dispatchRole } from "./dispatch/dispatch-role";
import { runStages, startStage } from "./engine/stage-runner";
import { type ResumePlan, type Route, runRoute } from "./task-routing";
import type { FlowResult } from "./tasks/task-result";
import { closeTask, RESUMABLE_OUTCOMES } from "./tasks/task-result";
import { deriveThreadState, isIdleLike } from "./thread/thread-state";

/** Everything one task run needs from the handler (which owns the lock and the task row). */
export interface RoleRunCtx {
  deps: DispatchDeps;
  log: Logger;
  task: Task;
  taskId: string;
  /** Start time of the call (for `task.finished`). */
  t0: number;
  workspace: string;
  repos: Repo[];
  ac: AbortController;
  /** A read-only role may hand work over only when the next role can ask for the owner's approval. */
  allowDelegate: boolean;
  /** Creates the task row (called once, after the refusals, before the flow runs). */
  begin: (repo: string, type: "qa" | "code", mode: string, cls?: TaskClass) => void;
  /** Repo of the log context, to report when the flow named none. */
  taskRepo: () => string;
}

/**
 * Run a routed message as the role the route names (the stage runner runs ANY role): close its task row, then
 * hand over a recorded proposal (AFTER the turn is closed) and map a failed resume to the owner's reply.
 * `plan` is what `resolveCommand` made of the message (Resume adds a session / plan scratch dir).
 */
export async function runTurn(
  c: RoleRunCtx,
  a: {
    route: Route;
    plan: ResumePlan;
    /** Thread session when the command has none of its own. */
    existing: SessionRow | null;
    extraBudgetUsd?: number;
  },
): Promise<string> {
  const { deps, task, taskId, workspace: ws } = c;
  const { db } = deps;
  const { cmd, planResume } = a.plan;
  const { pinned, worktree } = a.route;
  const role = getRole(a.route.role);
  const existing = a.plan.existing ?? a.existing;
  const cls = "cls" in cmd ? cmd.cls : undefined; // owner `[design]`-style prefix
  const runRt = runRoute({ cls, extraBudgetUsd: a.extraBudgetUsd });
  // State BEFORE the new row exists (it would read as `running`): an idle thread's read-only role sees its task ledger.
  const state = deriveThreadState(db, task.threadId);
  logEvent(c.log, "thread.state", { state });
  const ledger = role.readOnly && isIdleLike(state) ? threadLedger(db, task.threadId) : "";
  c.begin(a.route.repo, role.readOnly ? "qa" : "code", startStage(role, !!worktree).name, cls);
  const res: FlowResult = await runStages(deps, {
    taskId,
    threadId: task.threadId,
    text: cmd.text,
    role: role.name,
    workspace: ws,
    // A read-only role sees every repo of the workspace; the plan stage picks among the managed clones.
    repos: role.readOnly ? c.repos : a.route.candidates,
    ac: c.ac,
    worktree,
    planResume,
    route: runRt,
    resume:
      worktree && existing?.cwd === realOrSame(worktree.path) ? existing.session_id : undefined,
    pinned,
    existing,
    allowDelegate: c.allowDelegate,
    ledger,
  });
  const o = { stopping: deps.stopping(), t0: c.t0, repo: c.taskRepo() };
  const reply = closeTask(db, { taskId, threadId: task.threadId }, res, o);
  // `DelegateTask` was called: the proposed role starts now, same thread and lock (`await`: finally must wait).
  if (res.proposal && RESUMABLE_OUTCOMES.has(res.outcome)) {
    return dispatchRole(deps, {
      request: {
        role: res.proposal.role,
        brief: res.proposal.brief,
        repo: res.proposal.repo,
        cls,
      },
      task,
      reply,
      workspace: ws,
      repos: c.repos,
      pinned,
      ac: c.ac,
      fromTaskId: taskId,
    });
  }
  // Genuine resume failure only: drop the stale session. Transient errors keep it (and the prompt).
  if (res.outcome === "error" && RESUME_FAILED.test(res.text)) {
    // The plan session lives on the task row (the failed task now has none, so Resume stops offering it).
    if (planResume) return "Could not resume the plan; start the task again.";
    if (!role.readOnly || !existing) return reply;
    deleteSession(db, task.threadId);
    return "Could not resume the previous session; it was cleared. Please send your message again.";
  }
  return reply;
}
