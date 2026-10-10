import type { IntentDeps } from "../intent/decide-intent";
import { logEvent } from "../observability/logger";
import type { SessionRow } from "../storage/session-store";
import { PROPOSAL_EXPIRED_REPLY, pendingProposalFor } from "./dispatch/proposal-flow";
import { drainQueued } from "./dispatch/queued-tasks";
import { startPendingProposal } from "./dispatch/start-proposal";
import { findRepo } from "./dispatch/task-repo";
import { intentTurn, pinnedRepo } from "./intent-turn";
import { type RoleRunCtx, runTurn } from "./run-turn";
import type { TaskCommand } from "./task-commands";
import { PLAIN_GO, resolveCommand, routeTask } from "./task-routing";
import { refused } from "./tasks/task-tracker";
import type { EffortFloors } from "./thread/effort-floor";
import type { IntentOutcome } from "./thread/route-by-intent";

/** What the handler hands over once it holds the lock and knows the workspace. */
export interface RouteAndRunInput {
  rc: RoleRunCtx;
  parsed: Exclude<TaskCommand, { kind: "stop" | "cleanup" | "memory" }>;
  /** The thread's stored session. */
  stored: SessionRow | null;
  floors: EffortFloors;
  /** Undefined = the intent layer is off (tests): every message goes to the legacy pick (worktree owner / entry role). */
  intent?: IntentDeps;
  hasApprovals: boolean;
}

/**
 * From a parsed command to a finished run: `go` starts the pending proposal; the Resume button becomes a
 * follow-up / plan run / Q&A; a PLAIN message goes through the intent layer (which picks the role and may
 * ask, queue or open a task instead) and then `routeTask` + `runTurn`. Queued tasks start when this one ends.
 */
export async function routeAndRun(c: RouteAndRunInput): Promise<string> {
  const { rc, parsed, stored } = c;
  const { db, config } = rc.deps;
  const { task, workspace: ws, repos } = rc;
  /** Start the thread's queued tasks (the owner said yes) once this turn is over. */
  const done = async (reply: string) =>
    drainQueued({ ...rc, pinned: pinnedRepo(repos, undefined, stored) }, reply);
  // `go` starts the thread's pending proposal (it survived a restart), else it resumes like the button.
  const pending = parsed.kind === "go" ? pendingProposalFor(db, task.threadId, ws) : null;
  if (pending === "expired") return PROPOSAL_EXPIRED_REPLY;
  if (parsed.kind === "go" && pending) {
    const pinned = repos.find((r) => r.name === stored?.repo);
    return done(await startPendingProposal({ ...rc, pinned }, pending, parsed.extraBudgetUsd));
  }
  let extraBudgetUsd = "extraBudgetUsd" in parsed ? parsed.extraBudgetUsd : undefined;
  const input = parsed.kind === "go" ? { kind: "resume" as const, extraBudgetUsd } : parsed;
  // Resume button becomes a follow-up / plan run / Q&A from the interrupted task's session (or a refusal).
  const rdeps = { db, agentHome: config.agentHome, workspace: ws, repos };
  let resolved = resolveCommand(rdeps, input, task.threadId);
  // Only an ordinary message goes through the intent layer: a bare `go` that falls back to plain text is still L0
  // (legacy pick: follow-up in the clone, else the entry role), and a Resume keeps its own role.
  const plain = parsed.kind === "task";
  // `go` with nothing to start or resume is an ordinary message (e.g. "go" as a follow-up in a worktree).
  if (parsed.kind === "go" && "reply" in resolved && PLAIN_GO.has(resolved.reason)) {
    resolved = resolveCommand(rdeps, { kind: "task", text: task.text.trim() }, task.threadId);
    extraBudgetUsd = undefined; // the raise belongs to a resume, not a plain message
  }
  if ("reply" in resolved) return refused(rc.log, resolved);
  // The intent layer picks the role of a plain message (a Resume keeps its own role).
  let picked: (IntentOutcome & { kind: "run" }) | undefined;
  // (empty text / unknown `repo:` fall through: `routeTask` refuses them with its own reply)
  const answerable =
    !!resolved.cmd.text && !(resolved.cmd.repo && !findRepo(repos, resolved.cmd.repo));
  if (c.intent && plain && answerable) {
    const out = await intentTurn({
      ...rc,
      intent: c.intent,
      floors: c.floors,
      stored,
      busy: false,
      cmd: resolved.cmd,
    });
    if (out.kind === "reply") return done(out.text);
    picked = out;
  }
  const route = routeTask(
    { db, agentHome: config.agentHome, hasApprovals: c.hasApprovals },
    {
      cmd: resolved.cmd,
      threadId: task.threadId,
      repos,
      existing: resolved.existing ?? stored,
      role: picked?.role,
    },
  );
  if ("reply" in route) {
    logEvent(rc.log, route.event, { reason: route.reason, reply: route.reply });
    return route.reply;
  }
  return done(
    await runTurn(rc, { route, plan: resolved, existing: stored, extraBudgetUsd, intent: picked }),
  );
}
