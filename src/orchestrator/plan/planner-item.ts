import type { Database } from "bun:sqlite";
import { excerpt } from "../../observability/logger";
import { PLANNER_ROLE } from "../../roles/builtin/planner-role";
import { childrenOf } from "../../storage/owned-item-store";
import { insertOwnedTask } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { SCOPE_CHARS } from "../../tasks/task-resolver";
import { subjectFromBrief } from "../../tasks/task-subject";
import { PLANNER_KEY } from "./plan-types";

/** Planner items of the goal: the first is `planner`, the next ones `planner-2`, `planner-3`... (the wave count reads them). */
export const plannerCount = (db: Database, goalId: string): number =>
  childrenOf(db, goalId).filter((i) => i.itemKey?.startsWith(PLANNER_KEY)).length;

/**
 * Insert one planner item (`ready`) in a goal and its `start` work order, in the caller's transaction. The key is the next
 * free `planner-N`; `eventId` is the idempotency key of the work order (Orchestrate request_plan: its call key, a wave: derived from the
 * key). Shared by `Orchestrate request_plan` (the lead asks) and the rolling waves (code asks).
 */
export function insertPlannerItem(
  db: Database,
  a: {
    goalId: string;
    threadId: string;
    correlationId: string;
    objective: string;
    brief: string;
    eventId: (key: string) => string;
    /** Extra payload of the `start` event (who asked). */
    payload: Record<string, unknown>;
  },
): { key: string; itemId: string } {
  const n = plannerCount(db, a.goalId);
  const key = n === 0 ? PLANNER_KEY : `${PLANNER_KEY}-${n + 1}`;
  const itemId = crypto.randomUUID();
  insertOwnedTask(db, {
    id: itemId,
    threadId: a.threadId,
    ownerRole: PLANNER_ROLE.name,
    status: "ready",
    scope: excerpt(a.objective, SCOPE_CHARS),
    correlationId: a.correlationId,
    parentId: a.goalId,
    itemKey: key,
    brief: a.brief,
    subject: subjectFromBrief(`Plan: ${a.objective}`),
  });
  appendEvent(db, {
    id: a.eventId(key),
    threadId: a.threadId,
    kind: "start",
    taskId: a.goalId,
    itemId,
    correlationId: a.correlationId,
    payload: { key, role: PLANNER_ROLE.name, strategy: "PLAN", ...a.payload },
  });
  return { key, itemId };
}
