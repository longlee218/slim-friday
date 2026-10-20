import { clip, redactText } from "../../observability/redact";
import { childrenOf } from "../../storage/owned-item-store";
import { lastEventOfItem } from "../../storage/thread-event-store";
import { searchTasks, taskDetail } from "../goal/task-reads";
import type { GetTaskInput, SearchTasksInput } from "../lead/task-schemas";
import type { Reply } from "../reply";
import type { GoalInput } from "./plan-schemas";
import { type PlannerCtx, wrongGoal } from "./planner-handlers";

/* The planner's read-only views of how the goal is going. */

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

/**
 * The item table of the goal; an item that is blocked, failed or waiting carries its `cause` (the last failure-like
 * event). One view for the planner's `list` action (it merges the two reads above).
 */
export function listGoalItems(c: PlannerCtx, i: GoalInput): Reply {
  const progress = getExecutionProgress(c, i);
  const blockers = analyzeBlockers(c, i);
  if (!progress.ok) return progress;
  const causes = new Map(
    ((blockers.ok ? blockers.blockers : []) as { key: string | null; cause: unknown }[]).map(
      (b) => [b.key, b.cause],
    ),
  );
  return {
    ok: true,
    items: (progress.items as { key: string | null }[]).map((x) =>
      causes.has(x.key) ? { ...x, cause: causes.get(x.key) } : x,
    ),
  };
}

/**
 * One task or goal of this thread in full (the same view the lead's `get` returns). The planner knows its items by plan
 * key, so a `taskId` equal to the key of exactly one item of ITS OWN goal reads that item; anything else is an id.
 */
export const getTaskHandler = (c: PlannerCtx, i: GetTaskInput): Reply => {
  const byKey = childrenOf(c.db, c.goalId).filter((x) => x.itemKey === i.taskId);
  return taskDetail(c.db, c.threadId, byKey.length === 1 ? byKey[0].id : i.taskId);
};

/** The thread's goals and tasks that contain the query's words (the same view the lead's `search` returns). */
export const searchTasksHandler = (c: PlannerCtx, i: SearchTasksInput): Reply =>
  searchTasks(c.db, c.threadId, i.query);
