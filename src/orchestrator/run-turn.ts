import type { Logger } from "pino";
import type { Effort, TaskClass } from "../config/model-routing";
import type { InboundMessage } from "../ingress/discord-message-handler";
import { logEvent } from "../observability/logger";
import type { Repo } from "../repos/repo-registry";
import { getRole } from "../roles/role-registry";
import { RESUME_FAILED } from "../runtime/run-errors";
import { threadLedger } from "../storage/ledger-store";
import { dropResumable } from "../storage/run-store";
import { deleteSession, type SessionRow } from "../storage/session-store";
import type { DispatchDeps } from "./dispatch/dispatch-role";
import { runRole } from "./engine/run-role";
import { type ResumePlan, type Route, runRoute } from "./message-routing";
import { deriveThreadState, isIdleLike } from "./thread/thread-state";
import type { FlowResult } from "./turns/turn-result";
import { closeTurn } from "./turns/turn-result";

/** Everything one task run needs from the handler (which owns the lock and the turn row). */
export interface RoleRunCtx {
  deps: DispatchDeps;
  log: Logger;
  message: InboundMessage;
  turnId: string;
  /** Start time of the call (for `task.finished`). */
  t0: number;
  workspace: string;
  repos: Repo[];
  ac: AbortController;
  /** Creates the turn row (called once, after the refusals, before the flow runs). */
  begin: (
    repo: string,
    role: string,
    cls?: TaskClass,
    /** Task this run continues (interrupt Resume, `/go`): its row is a `resume` child, its spend counts against the same ceiling. */
    resumeOf?: string,
  ) => void;
  /** Repo of the log context, to report when the flow named none. */
  turnRepo: () => string;
}

/**
 * Run a routed message as the role the route names (the role runner runs ANY role): close its turn row and
 * map a failed resume to the owner's reply.
 * `plan` is what `resolveCommand` made of the message (a Resume adds the task's own session and cwd).
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
  const { deps, message, turnId, workspace: ws } = c;
  const { db } = deps;
  const { cmd, resume } = a.plan;
  const { pinned } = a.route;
  const role = getRole(a.route.role);
  const existing = a.plan.existing ?? a.existing;
  const cls = ("cls" in cmd ? cmd.cls : undefined) ?? a.intent?.cls; // owner `[design]` prefix, else the intent class
  const runRt = runRoute({ cls, effort: a.intent?.effort, extraBudgetUsd: a.extraBudgetUsd });
  // State BEFORE the new row exists (it would read as `running`): a role with `context.ledger` sees its task ledger on an idle thread.
  const state = deriveThreadState(db, message.threadId);
  logEvent(c.log, "thread.state", { state });
  const ledger =
    role.context?.ledger && isIdleLike(state) ? threadLedger(db, message.threadId) : "";
  // A continued task keeps the repo of the task it continues (its row names it), so the ledger does not show `*`.
  const parentRepo = resume
    ? db.query<{ repo: string }, [string]>("SELECT repo FROM turns WHERE id = ?").get(resume.of)
        ?.repo
    : undefined;
  c.begin(
    a.route.repo === "*" && parentRepo ? parentRepo : a.route.repo,
    role.name,
    cls,
    resume?.of,
  );
  const res: FlowResult = await runRole(deps, {
    turnId,
    threadId: message.threadId,
    text: cmd.text,
    role: role.name,
    workspace: ws,
    // `repoScope: "all"` roles see every repo of the workspace; the others the candidates.
    repos: role.repoScope === "all" ? c.repos : a.route.candidates,
    ac: c.ac,
    resume,
    route: runRt,
    // The held task is taken over only when the run really starts (repo gone, a failed role check keep the hold).
    onStarted: resume ? () => dropResumable(db, message.threadId) : undefined,
    pinned,
    existing,
    ledger,
  });
  const o = { stopping: deps.stopping(), t0: c.t0, repo: c.turnRepo() };
  const reply = closeTurn(db, { turnId, threadId: message.threadId }, res, o);
  // Genuine resume failure only: drop the stale session. Transient errors keep it (and the prompt).
  if (res.outcome === "error" && RESUME_FAILED.test(res.text)) {
    // A background task's session lives on its turn row: the owner starts the task again.
    if (resume) return "Could not resume the task's session; start the task again.";
    // Only a foreground role keeps a thread session to clear.
    if (role.background || !existing) return reply;
    deleteSession(db, message.threadId);
    return "Could not resume the previous session; it was cleared. Please send your message again.";
  }
  return reply;
}
