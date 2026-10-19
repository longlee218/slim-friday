import type { Database } from "bun:sqlite";

/* Read side of the `cancel` thread events: which items a lead or owner cancel stopped (used to settle a goal). */

/** Ids of the goal's items a lead/owner `cancel` event cancelled (the cancelled item and its cascade). */
export function cancelledByCancelEvents(db: Database, goalId: string): Set<string> {
  const rows = db
    .query<{ itemId: string | null; payload: string }, [string]>(
      "SELECT item_id AS itemId, payload FROM thread_events WHERE task_id = ? AND kind = 'cancel'",
    )
    .all(goalId);
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.itemId) ids.add(r.itemId);
    const cancelled = (JSON.parse(r.payload) as { cancelled?: unknown }).cancelled;
    if (Array.isArray(cancelled))
      for (const id of cancelled) if (typeof id === "string") ids.add(id);
  }
  return ids;
}
