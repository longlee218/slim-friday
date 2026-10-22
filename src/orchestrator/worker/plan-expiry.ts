import { PENDING_PLAN_MAX_AGE_MS } from "../../config/lead-caps";
import {
  ORCHESTRATE_ACTION_REQUEST_PLAN,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { logEvent, logger } from "../../observability/logger";
import { taskOrigin } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { expiredValidPlans } from "../../storage/work-plan-store";
import { ASK_OWNER_TIMEOUT_MS } from "../lead/lead-limits";
import type { LeadRuntime } from "../lead/lead-runtime";
import { rejectVersion } from "../plan/plan-lifecycle";
import { settleGoal } from "./goal-settle";

/** Logger of this module. */
const log = logger.child({ module: "plan-expiry" });

/* A plan nobody answered for `PENDING_PLAN_MAX_AGE_MS` (plus one owner-question timeout, so a question asked just before
   the limit can still be answered) stops holding its goal: the version is rejected (as the owner's
   "no": a goal that never had an approved plan or other work closes, any other goal goes on), the goal settles when all
   its items ended, and one `timeout` event wakes the lead so it can tell the owner. */

/** One sweep at `now`: expire every pending plan over the limit. Returns how many versions it expired. */
export function sweepPendingPlans(rt: LeadRuntime, now = Date.now()): number {
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
        error: `The owner did not answer the plan in time: it was rejected. Tell the owner it lapsed and ask whether to plan again; if yes, ${orchestrateRef(ORCHESTRATE_ACTION_REQUEST_PLAN)} with this goalId.`,
      },
    });
    settleGoal(db, row.goalId);
    logEvent(log, "plan.expired", { planId: row.id, version: row.version }, "warn");
    rt.announce(goal.threadId);
    expired++;
  }
  return expired;
}
