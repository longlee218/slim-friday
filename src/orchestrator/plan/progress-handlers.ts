import { clip, redactText } from "../../observability/redact";
import { childrenOf } from "../../storage/owned-item-store";
import { lastEventOfItem } from "../../storage/thread-event-store";
import type { Reply } from "../reply";
import type { GoalInput } from "./plan-schemas";
import { type PlannerCtx, wrongGoal } from "./planner-handlers";

/* The planner's two read-only views of how the goal is going. */

/** Chars of an excerpt / failure payload shown to the planner. */
const EXCERPT_CHARS = 300;

/** The item table: status, result kind, excerpt, attempt. */
export function getExecutionProgress(c: PlannerCtx, i: GoalInput): Reply {
  if (i.goalId !== c.goalId) return wrongGoal(i.goalId);
  return {
    ok: true,
    items: childrenOf(c.db, c.goalId).map((x) => ({
      key: x.itemKey,
      status: x.status,
      resultKind: x.resultKind,
      excerpt: clip(redactText(x.resultExcerpt ?? ""), EXCERPT_CHARS),
      attempt: x.attempt,
    })),
  };
}

/** Blocked, failed and waiting items with their cause: the result kind and the last failure-like event. */
export function analyzeBlockers(c: PlannerCtx, i: GoalInput): Reply {
  if (i.goalId !== c.goalId) return wrongGoal(i.goalId);
  const stuck = childrenOf(c.db, c.goalId).filter((x) =>
    ["blocked", "failed", "waiting_user"].includes(x.status),
  );
  return {
    ok: true,
    blockers: stuck.map((x) => {
      const last = lastEventOfItem(c.db, x.id, [
        "failure",
        "blocked",
        "budget_hit",
        "timeout",
        "question",
      ]);
      return {
        key: x.itemKey,
        status: x.status,
        resultKind: x.resultKind,
        cause: last && { kind: last.kind, detail: clip(redactText(last.payload), EXCERPT_CHARS) },
      };
    }),
  };
}
