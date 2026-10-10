import type { Logger } from "pino";
import type { Effort, TaskClass } from "../config/model-routing";
import { realOrSame } from "../guardrails/paths";
import type { Task } from "../ingress/discord-message-handler";
import { logEvent } from "../observability/logger";
import type { Repo } from "../repos/repo-registry";
import { getRole } from "../roles/role-registry";
import { RESUME_FAILED } from "../runtime/run-errors";
import { threadLedger } from "../storage/ledger-store";
import { deleteSession, type SessionRow } from "../storage/session-store";
import { liveWorktree } from "../storage/worktree-store";
import type { DispatchDeps } from "./dispatch/dispatch-role";
import { runStages, startStage } from "./engine/stage-runner";
import { type ResumePlan, type Route, runRoute } from "./task-routing";
import type { FlowResult } from "./tasks/task-result";
import { closeTask } from "./tasks/task-result";
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
  /** Creates the task row (called once, after the refusals, before the flow runs). */
  begin: (
    repo: string,
    role: string,
    mode: string,
    cls?: TaskClass,
    /** Task whose clone a follow-up (fix round) continues. */
    parentTaskId?: string,
  ) => void;
  /** Repo of the log context, to report when the flow named none. */
  taskRepo: () => string;
}

/**
 * Run a routed message as the role the route names (the stage runner runs ANY role): close its task row and
 * map a failed resume to the owner's reply.
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
    /** What the intent layer decided for this run: class (owner prefix wins) and effort (signals / floor). */
    intent?: { cls?: TaskClass; effort?: Effort };
  },
): Promise<string> {
  const { deps, task, taskId, workspace: ws } = c;
  const { db } = deps;
  const { cmd, planResume } = a.plan;
  const { pinned, worktree } = a.route;
  const role = getRole(a.route.role);
  const existing = a.plan.existing ?? a.existing;
  const cls = ("cls" in cmd ? cmd.cls : undefined) ?? a.intent?.cls; // owner `[design]` prefix, else the intent class
  const runRt = runRoute({ cls, effort: a.intent?.effort, extraBudgetUsd: a.extraBudgetUsd });
  // State BEFORE the new row exists (it would read as `running`): a role with `context.ledger` sees its task ledger on an idle thread.
  const state = deriveThreadState(db, task.threadId);
  logEvent(c.log, "thread.state", { state });
  const ledger = role.context?.ledger && isIdleLike(state) ? threadLedger(db, task.threadId) : "";
  c.begin(a.route.repo, role.name, startStage(role, !!worktree).name, cls, worktree?.taskId);
  const res: FlowResult = await runStages(deps, {
    taskId,
    threadId: task.threadId,
    text: cmd.text,
    role: role.name,
    workspace: ws,
    // `repoScope: "all"` roles see every repo of the workspace; the others pick among the managed clones.
    repos: role.repoScope === "all" ? c.repos : a.route.candidates,
    ac: c.ac,
    worktree,
    planResume,
    route: runRt,
    resume:
      worktree && existing?.cwd === realOrSame(worktree.path) ? existing.session_id : undefined,
    pinned,
    existing,
    ledger,
  });
  const o = { stopping: deps.stopping(), t0: c.t0, repo: c.taskRepo() };
  // An answer in a thread that has a clone must not replace the thread's session (the clone's fix rounds resume it).
  const keepClone = role.output === "answer" && !!liveWorktree(db, task.threadId);
  const reply = closeTask(
    db,
    { taskId, threadId: task.threadId },
    keepClone ? { ...res, sessionId: undefined } : res,
    o,
  );
  // Genuine resume failure only: drop the stale session. Transient errors keep it (and the prompt).
  if (res.outcome === "error" && RESUME_FAILED.test(res.text)) {
    // The plan session lives on the task row (the failed task now has none, so Resume stops offering it).
    if (planResume) return "Could not resume the plan; start the task again.";
    // Only an `answer` role keeps a thread session to clear; staged roles resume per task row.
    if (role.output !== "answer" || !existing) return reply;
    deleteSession(db, task.threadId);
    return "Could not resume the previous session; it was cleared. Please send your message again.";
  }
  return reply;
}
