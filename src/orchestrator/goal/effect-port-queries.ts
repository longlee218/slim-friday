import type { Database } from "bun:sqlite";
import { clip, redactText } from "../../observability/redact";
import { LEAD_ROLE } from "../../roles/builtin/lead-role";
import {
  childrenOf,
  getItem,
  goalOf,
  latestGoalId,
  openGoalId,
} from "../../storage/owned-item-store";
import { taskScope } from "../../storage/owned-task-store";
import { countChainStarts, lastEventOfItem } from "../../storage/thread-event-store";
import { PENDING_PLAN_MAX_AGE_MS } from "../../storage/work-plan-store";
import type { Caps } from "../strategy/caps";
import { progressOf } from "../worker/run-activity";
import type { TaskSnapshot } from "./effect-port";

/* Read-only db queries of the db-backed EffectPort (caps counters, the open goal, a worker's pending question). */

/**
 * Id of the thread's open goal: its newest lead goal with status `open` and at least one unfinished item (or no item
 * yet) or a plan waiting for the owner (not older than `PENDING_PLAN_MAX_AGE_MS`). A goal whose items all ended is done even while its row still says `open`.
 */
export function openGoalIdOf(db: Database, threadId: string, now = Date.now()): string | undefined {
  return openGoalId(db, threadId, LEAD_ROLE.name, now - PENDING_PLAN_MAX_AGE_MS);
}

/**
 * Cap counters from the db: `start` events after the thread's last `owner_message` (the chain). A `start` materialized from an owner-approved plan
 * (`payload.plan`) is not counted: the owner already agreed to the whole plan, so its items are no chain.
 */
export function goalCaps(db: Database, threadId: string): Omit<Caps, "dispatchedThisRun"> {
  return { chainCount: countChainStarts(db, threadId) };
}

/** The question a worker waits on (its newest `question` event of the item with no `answer` after it), redacted. */
export function pendingQuestionOf(db: Database, itemId: string): string | undefined {
  const last = lastEventOfItem(db, itemId, ["question", "answer"]);
  if (last?.kind !== "question") return undefined;
  const q = (JSON.parse(last.payload) as { question?: unknown } | null)?.question;
  return typeof q === "string" ? clip(redactText(q), 400) : undefined;
}

/** Facts of the goal of `taskId` (or the thread's newest goal): goal sentence + one facts row per item. */
export function snapshotOf(db: Database, threadId: string, taskId?: string): TaskSnapshot {
  const goalId = taskId
    ? (goalOf(db, taskId) ?? taskId)
    : latestGoalId(db, threadId, LEAD_ROLE.name);
  if (!goalId) return { items: [] };
  const intent = taskScope(db, goalId);
  return {
    goalId,
    ...(intent && { intent }),
    items: childrenOf(db, goalId).map((it) => {
      const pendingQuestion = pendingQuestionOf(db, it.id);
      const progress = progressOf(it.id);
      return {
        id: it.id,
        key: it.itemKey,
        status: it.status,
        ...(pendingQuestion && { pendingQuestion }),
        ...(progress && { progress }),
        resultKind: it.resultKind,
        resultExcerpt: it.resultExcerpt,
        resultPath: it.resultPath,
      };
    }),
  };
}

/**
 * Task ids to cancel for `id`: a goal = itself plus all its items; an item = itself plus every item that waits for it
 * (transitively through `dependsOn`).
 */
export function cancelSet(db: Database, id: string): string[] {
  const row = getItem(db, id);
  if (!row) return [];
  if (!row.parentId) return [id, ...childrenOf(db, id).map((c) => c.id)];
  const items = childrenOf(db, row.parentId);
  const keys = new Set([row.itemKey as string]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const it of items)
      if (it.itemKey && !keys.has(it.itemKey) && it.dependsOn.some((k) => keys.has(k))) {
        keys.add(it.itemKey);
        grew = true;
      }
  }
  return items.filter((it) => it.itemKey && keys.has(it.itemKey)).map((it) => it.id);
}
