import type { Database } from "bun:sqlite";
import type { EventKind, ThreadEvent } from "../orchestrator/events/event-types";

/* Outbox of thread events (table `thread_events`). Delivery = claim by a consumer turn, then mark delivered when
   that turn ended. A claim whose turn is gone is released (`unclaimStale`) and read again, flagged. */

/** Raw row: `payload` is JSON text, `redelivered` an integer flag. */
interface Raw {
  seq: number;
  id: string;
  threadId: string;
  taskId: string | null;
  itemId: string | null;
  kind: EventKind;
  payload: string;
  correlationId: string | null;
  causationId: string | null;
  createdAt: number;
  deliveredAt: number | null;
  redelivered: number;
}

const COLUMNS = `seq, id, thread_id AS threadId, task_id AS taskId, item_id AS itemId, kind, payload,
  correlation_id AS correlationId, causation_id AS causationId, created_at AS createdAt,
  delivered_at AS deliveredAt, redelivered`;

/** Raw row to event (absent optional columns are left out). */
const toEvent = (r: Raw): ThreadEvent => ({
  id: r.id,
  threadId: r.threadId,
  ...(r.taskId && { taskId: r.taskId }),
  ...(r.itemId && { itemId: r.itemId }),
  kind: r.kind,
  payload: JSON.parse(r.payload),
  ...(r.correlationId && { correlationId: r.correlationId }),
  ...(r.causationId && { causationId: r.causationId }),
  createdAt: r.createdAt,
  ...(r.deliveredAt !== null && { deliveredAt: r.deliveredAt }),
  ...(r.redelivered && { redelivered: true as const }),
});

/** Append an event. The same `id` twice is a no-op (idempotent). Returns true when a row was written. */
export function appendEvent(
  db: Database,
  e: Omit<ThreadEvent, "createdAt" | "deliveredAt" | "redelivered"> & { createdAt?: number },
): boolean {
  const res = db
    .query(
      `INSERT OR IGNORE INTO thread_events (id, thread_id, task_id, item_id, kind, payload, correlation_id,
         causation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.id,
      e.threadId,
      e.taskId ?? null,
      e.itemId ?? null,
      e.kind,
      JSON.stringify(e.payload ?? null),
      e.correlationId ?? null,
      e.causationId ?? null,
      e.createdAt ?? Date.now(),
    );
  return res.changes === 1;
}

/**
 * Release the claims of turns that are gone (crash / restart): a claim is stale when its turn is missing or no
 * longer `running` / `waiting_approval` in `turns`. The events become claimable again, flagged `redelivered`.
 * Safe at boot (no turn is alive then) and at any time. Returns how many rows were released.
 */
export function unclaimStale(db: Database): number {
  return db
    .query(
      `UPDATE thread_events SET claimed_by = NULL, redelivered = 1
       WHERE delivered_at IS NULL AND claimed_by IS NOT NULL
         AND claimed_by NOT IN (SELECT id FROM turns WHERE status IN ('running', 'waiting_approval'))`,
    )
    .run().changes;
}

/** Threads that still have an undelivered, unclaimed event (what a restart must wake). */
export function undeliveredThreads(db: Database): string[] {
  return db
    .query<{ t: string }, []>(
      "SELECT DISTINCT thread_id AS t FROM thread_events WHERE delivered_at IS NULL AND claimed_by IS NULL",
    )
    .all()
    .map((r) => r.t);
}

/** Undelivered events of a thread (claimed or not), oldest first; read-only. */
export function listUndelivered(db: Database, threadId: string): ThreadEvent[] {
  return db
    .query<Raw, [string]>(
      `SELECT ${COLUMNS} FROM thread_events WHERE thread_id = ? AND delivered_at IS NULL ORDER BY seq`,
    )
    .all(threadId)
    .map(toEvent);
}

/**
 * `/stop`: the thread's undelivered `start` events (work that never began) are closed as delivered and marked
 * `cancelled` (in `claimed_by`), so no lead run picks them up later. A row claimed by a live consumer (its turn is
 * `running` / `waiting_approval`) is left alone; unclaimed and stale claims are closed. Returns how many were closed.
 */
export function cancelStartEvents(db: Database, threadId: string): number {
  return db
    .query(
      `UPDATE thread_events SET delivered_at = ?, claimed_by = 'cancelled'
       WHERE thread_id = ? AND kind = 'start' AND delivered_at IS NULL
         AND (claimed_by IS NULL OR claimed_by NOT IN
           (SELECT id FROM turns WHERE status IN ('running', 'waiting_approval')))`,
    )
    .run(Date.now(), threadId).changes;
}

/** Close events by id as delivered (the lead run that read them ended; a record needs no reader). Returns how many rows changed. */
export function markDeliveredIds(db: Database, ids: string[]): number {
  if (!ids.length) return 0;
  const now = Date.now();
  return db.transaction(() => {
    let n = 0;
    for (const id of ids)
      n += db
        .query("UPDATE thread_events SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL")
        .run(now, id).changes;
    return n;
  })();
}

/** A work order was taken (its item was dispatched): the item's `start` event is delivered. */
export function markStartDelivered(db: Database, itemId: string): number {
  return db
    .query(
      "UPDATE thread_events SET delivered_at = ?, claimed_by = 'dispatch' WHERE item_id = ? AND kind = 'start' AND delivered_at IS NULL",
    )
    .run(Date.now(), itemId).changes;
}

/**
 * Newest event of an item whose kind is in `kinds` (kind + raw JSON payload), or undefined. `kinds` are code
 * constants, never owner input.
 */
export function lastEventOfItem(
  db: Database,
  itemId: string,
  kinds: readonly EventKind[],
): { kind: string; payload: string } | undefined {
  const marks = kinds.map((k) => `'${k}'`).join(", ");
  return (
    db
      .query<{ kind: string; payload: string }, [string]>(
        `SELECT kind, payload FROM thread_events WHERE item_id = ? AND kind IN (${marks}) ORDER BY seq DESC LIMIT 1`,
      )
      .get(itemId) ?? undefined
  );
}

/**
 * `start` events after the thread's last `owner_message` (the dispatch chain). A `start` materialized from an
 * owner-approved plan (`payload.plan`) is not counted.
 */
export function countChainStarts(db: Database, threadId: string): number {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM thread_events
       WHERE thread_id = ? AND kind = 'start' AND COALESCE(json_extract(payload, '$.plan'), 0) != 1
         AND seq > COALESCE((SELECT MAX(seq) FROM thread_events WHERE thread_id = ? AND kind = 'owner_message'), 0)`,
    )
    .get(threadId, threadId);
  return row?.n ?? 0;
}
