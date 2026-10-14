import type { Database } from "bun:sqlite";
import type { IntentDecision } from "../intent/decide-intent";
import { getLogContext, logger } from "../observability/logger";
import { hasClassTiers, ROLES } from "../roles/role-registry";
import { routeWithRecovery } from "../routing/route-with-recovery";
import type { ReasonCode, RoutingDecision, TaskState } from "../routing/routing-contracts";
import type { RoutePlan } from "../routing/routing-policy";
import { changeOwner } from "../tasks/task-resolver";
import type { Refusal } from "./dispatch/task-location";
import type { IntentTurnCtx } from "./intent-turn";
import { stripRoleTag } from "./thread/intent-replies";
import { actionFor, type IntentAction } from "./thread/intent-table";
import type { ThreadState } from "./thread/thread-state";

/** Logger of this module. */
const log = logger.child({ module: "recover-route" });

/** The route after recovery: what to run (or the one reply) and the trace fields the executor needs. */
export interface RecoveredRoute {
  decision: IntentDecision;
  action: IntentAction;
  routing: RoutingDecision;
  extra: Record<string, unknown>;
  /** Waiting task whose session continues (undefined after a reroute: another role does not resume it). */
  continueTask?: TaskState;
  /** Owned task the new turn links to. */
  ownedTaskId?: string;
  /** Set when nothing runs: the one reply the owner gets. */
  reply?: string;
  /** The legacy refusal behind `reply` (absent for a question with no failed check); the caller logs it once. */
  refusal?: Refusal;
}

/**
 * A reroute to another background role takes the waiting task over (CAS, logged by `changeOwner`). Returns the task id
 * the new run links to; when the move fails (lost race, refused) the run must not join the old task: undefined = a
 * fresh task.
 */
export function followTask(
  db: Database,
  task: TaskState,
  to: string,
  reasonCode: ReasonCode,
  move: typeof changeOwner = changeOwner,
): string | undefined {
  if (move(db, task, to, reasonCode, getLogContext().traceId ?? crypto.randomUUID()))
    return task.taskId;
  log.warn({ ownedTaskId: task.taskId, to }, "task.follow_failed");
  return undefined;
}

/**
 * Preflight + bounded recovery of the policy's route (a run that starts now only). One reroute at most; an explicit
 * `[tag]` is never rerouted. A reroute from the owner of a waiting background task to another background role moves
 * the task (`changeOwner`); to a foreground role the task stays untouched. The refusal of a rerouted candidate is
 * never logged: only the final exit (clarify / safe fail) returns one.
 */
export async function recoverRoute(
  c: IntentTurnCtx,
  plan: RoutePlan,
  state: ThreadState,
): Promise<RecoveredRoute> {
  const { decision } = plan;
  const action = actionFor({ decision, state });
  const base: RecoveredRoute = {
    decision,
    action,
    routing: plan.routing,
    extra: plan.extra,
    continueTask: plan.continueTask,
    ownedTaskId: plan.continueTask?.taskId,
  };
  if (c.busy || decision.kind !== "role" || !["run", "open"].includes(action.kind)) return base;

  const rec = await routeWithRecovery(
    c.log,
    {
      role: decision.role,
      text: stripRoleTag(c.cmd.text),
      locationHint: c.cmd.location,
      locations: c.locations,
      hasApprovals: !!c.deps.approvals,
      ranking: plan.ranking,
      db: c.deps.db,
    },
    { allowReroute: plan.routing.source !== "tag" },
  );
  const out: RecoveredRoute = {
    ...base,
    extra: {
      ...plan.extra,
      initialCandidate: rec.initial,
      rerouted: rec.rerouted,
      visited: rec.visited,
      preflight: rec.preflight,
    },
  };
  if (rec.kind !== "execute") {
    // A clarified message (a question, not a refusal) is source `clarify`; a safe fail keeps its route.
    if (rec.kind === "clarify" && rec.reasonCode)
      out.routing = { ...out.routing, source: "clarify", rationaleCode: rec.reasonCode };
    out.refusal = rec.refusal ?? {
      event: "task.refused",
      reason: "recovery",
      reply: rec.reply ?? "",
    };
    return out;
  }
  if (!rec.rerouted || !rec.rerouteReason) return out;

  // Another role takes the message. A background owner's task follows a background reroute (CAS, logged).
  const to = ROLES[rec.role];
  out.continueTask = undefined;
  out.ownedTaskId =
    plan.continueTask && to?.background
      ? followTask(c.deps.db, plan.continueTask, rec.role, rec.rerouteReason)
      : undefined;
  out.routing = {
    ...out.routing,
    source: "fallback",
    rationaleCode: rec.rerouteReason,
    candidateAgentId: rec.role,
  };
  out.decision = {
    kind: "role",
    role: rec.role,
    scope: "new",
    ...(to && hasClassTiers(to) && c.cmd.cls && { cls: c.cmd.cls }),
  };
  out.action = actionFor({ decision: out.decision, state });
  return out;
}
