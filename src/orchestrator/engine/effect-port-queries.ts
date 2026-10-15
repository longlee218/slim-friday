import type { Database } from "bun:sqlite";
import { clip, redactText } from "../../observability/redact";
import { LEAD_ROLE } from "../../roles/builtin/lead-role";
import { childrenOf, getItem, goalOf } from "../../storage/owned-item-store";
import { PENDING_PLAN_MAX_AGE_MS } from "../../storage/work-plan-store";
import type { Caps } from "../strategy/caps";
import type { TaskSnapshot } from "./effect-port";

/* Read-only db queries of the db-backed EffectPort (caps counters, the open goal, a worker's pending question). */

/** Item statuses that still count as work in progress. */
const OPEN_ITEM = "('pending', 'ready', 'running', 'waiting_user', 'blocked')";

/**
 * Id of the thread's open goal: its newest lead goal with status `open` and at least one unfinished item (or no item
 * yet) or a plan waiting for the owner (not older than `PENDING_PLAN_MAX_AGE_MS`). A goal whose items all ended is done even while its row still says `open`.
 */
export function openGoalIdOf(db: Database, threadId: string, now = Date.now()): string | undefined {
  return db
    .query<{ id: string }, [string, string, number]>(
      `SELECT g.id FROM owned_tasks g
       WHERE g.thread_id = ? AND g.parent_id IS NULL AND g.owner_role = ? AND g.status = 'open'
         AND (NOT EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id)
              OR EXISTS (SELECT 1 FROM owned_tasks i WHERE i.parent_id = g.id AND i.status IN ${OPEN_ITEM})
              OR EXISTS (SELECT 1 FROM work_plans p WHERE p.goal_id = g.id AND p.status IN ('draft', 'valid') AND p.created_at > ?))
       ORDER BY g.rowid DESC LIMIT 1`,
    )
    .get(threadId, LEAD_ROLE.name, now - PENDING_PLAN_MAX_AGE_MS)?.id;
}

/** Start of the local day of `now` (epoch ms): "today" of the daily lead budget. */
const startOfDay = (now: number): number => new Date(now).setHours(0, 0, 0, 0);

/**
 * Cap counters from the db: `start` events after the thread's last `owner_message` (the chain), and the cost of
 * today's lead runs (runs of turns whose role is `lead`). A `start` materialized from an owner-approved plan
 * (`payload.plan`) is not counted: the owner already agreed to the whole plan, so its items are no chain.
 */
export function goalCaps(
  db: Database,
  threadId: string,
  now: number,
): Omit<Caps, "dispatchedThisRun"> {
  const chain = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM thread_events
       WHERE thread_id = ? AND kind = 'start' AND COALESCE(json_extract(payload, '$.plan'), 0) != 1
         AND seq > COALESCE((SELECT MAX(seq) FROM thread_events WHERE thread_id = ? AND kind = 'owner_message'), 0)`,
    )
    .get(threadId, threadId);
  const spent = db
    .query<{ c: number }, [string, number]>(
      `SELECT COALESCE(SUM(r.cost_usd), 0) AS c FROM runs r JOIN turns t ON t.id = r.turn_id
       WHERE t.role = ? AND t.started_at >= ?`,
    )
    .get(LEAD_ROLE.name, startOfDay(now));
  return { chainCount: chain?.n ?? 0, leadSpentTodayUsd: spent?.c ?? 0 };
}

/** The question a worker waits on (its newest `question` event of the item with no `answer` after it), redacted. */
export function pendingQuestionOf(db: Database, itemId: string): string | undefined {
  const last = db
    .query<{ kind: string; payload: string }, [string]>(
      "SELECT kind, payload FROM thread_events WHERE item_id = ? AND kind IN ('question', 'answer') ORDER BY seq DESC LIMIT 1",
    )
    .get(itemId);
  if (last?.kind !== "question") return undefined;
  const q = (JSON.parse(last.payload) as { question?: unknown } | null)?.question;
  return typeof q === "string" ? clip(redactText(q), 400) : undefined;
}

/** Newest goal of the thread (any status), or undefined. Goals are the lead's rows without a parent. */
export function latestGoalId(db: Database, threadId: string): string | undefined {
  return db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM owned_tasks WHERE thread_id = ? AND parent_id IS NULL AND owner_role = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(threadId, LEAD_ROLE.name)?.id;
}

/** Facts of the goal of `taskId` (or the thread's newest goal): goal sentence + one facts row per item. */
export function snapshotOf(db: Database, threadId: string, taskId?: string): TaskSnapshot {
  const goalId = taskId ? (goalOf(db, taskId) ?? taskId) : latestGoalId(db, threadId);
  if (!goalId) return { items: [] };
  const intent = db
    .query<{ s: string }, [string]>("SELECT scope AS s FROM owned_tasks WHERE id = ?")
    .get(goalId)?.s;
  return {
    goalId,
    ...(intent && { intent }),
    items: childrenOf(db, goalId).map((it) => {
      const pendingQuestion = pendingQuestionOf(db, it.id);
      return {
        id: it.id,
        key: it.itemKey,
        status: it.status,
        ...(pendingQuestion && { pendingQuestion }),
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
