import { PENDING_PLAN_MAX_AGE_MS } from "../../config/teammate-caps";
import {
  ORCHESTRATE_ACTION_CREATE_PLAN,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { logEvent, logger } from "../../observability/logger";
import { CHIEF_OF_STAFF_ROLE } from "../../roles/builtin/chief-of-staff-role";
import { staleEmptyGoals } from "../../storage/owned-item-store";
import { taskOrigin } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { closePendingPlans, expiredValidPlans } from "../../storage/work-plan-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { rejectVersion } from "../plan/plan-lifecycle";
import { ASK_OWNER_TIMEOUT_MS } from "../teammate/teammate-limits";
import type { TeammateRuntime } from "../teammate/teammate-runtime";
import { settleGoal } from "./goal-settle";

/** Logger of this module. */
const log = logger.child({ module: "plan-expiry" });

/* A plan nobody answered for `PENDING_PLAN_MAX_AGE_MS` (plus one owner-question timeout, so a question asked just before
   the limit can still be answered) stops holding its goal: the version is rejected (as the owner's
   "no": the goal stays open for a re-plan), the goal settles when all
   its items ended, and one `timeout` event wakes the teammate so it can tell the owner. A PLAN goal with no item and no plan
   waiting (rejected, expired) that is older than twice the same limit (the teammate had a day to re-plan after the expiry) is cancelled: nobody asked for a re-plan. */

/** One sweep at `now`: expire every pending plan over the limit. Returns how many versions it expired. */
export function sweepPendingPlans(rt: TeammateRuntime, now = Date.now()): number {
  const { db } = rt.deps;
  let expired = 0;
  for (const row of expiredValidPlans(db, now - PENDING_PLAN_MAX_AGE_MS - ASK_OWNER_TIMEOUT_MS)) {
    const goal = taskOrigin(db, row.goalId);
    if (!goal || !rejectVersion(db, row.id, row.version, "expired").ok) continue;
    appendEvent(db, {
      id: `plan_expired:${row.id}:${row.version}`,
      threadId: goal.threadId,
      taskId: row.goalId,
      kind: "timeout",
      payload: {
        code: "PLAN_EXPIRED",
        goalId: row.goalId,
        planId: row.id,
        version: row.version,
        error: `The owner did not answer the plan in time: it was rejected. Tell the owner it lapsed and ask whether to plan again; if yes, ${orchestrateRef(ORCHESTRATE_ACTION_CREATE_PLAN)} with this goalId.`,
      },
    });
    settleGoal(db, row.goalId);
    logEvent(log, "plan.expired", { planId: row.id, version: row.version }, "warn");
    rt.announce(goal.threadId);
    expired++;
  }
  for (const g of staleEmptyGoals(
    db,
    CHIEF_OF_STAFF_ROLE.name,
    now - 2 * PENDING_PLAN_MAX_AGE_MS,
  )) {
    closePendingPlans(db, g.id, "expired");
    if (!moveTaskTo(db, g.id, "cancelled")) continue;
    appendEvent(db, {
      id: `plan_goal_closed:${g.id}`,
      threadId: g.threadId,
      taskId: g.id,
      kind: "timeout",
      payload: {
        code: "PLAN_GOAL_CLOSED",
        goalId: g.id,
        error:
          "A PLAN goal had no approved plan and no re-plan for a day: it was cancelled. Tell the owner if it matters.",
      },
    });
    rt.announce(g.threadId);
    expired++;
  }
  return expired;
}
