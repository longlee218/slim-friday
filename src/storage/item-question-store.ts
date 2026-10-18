import type { Database } from "bun:sqlite";

/* Which goal item a Discord question message is about: a reply to that message answers the item (a `waiting_user` item
   has no live run to ask through). Rows are tiny and keyed by the message id; a re-link of the same message replaces it. */

/** Remember that the message `messageId` of `threadId` asks the owner about `itemId`. */
export function linkQuestionMessage(
  db: Database,
  messageId: string,
  threadId: string,
  itemId: string,
): void {
  db.query(
    "INSERT OR REPLACE INTO item_questions (message_id, thread_id, item_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(messageId, threadId, itemId, Date.now());
}

/** Item a question message of this thread is about, or undefined (not a question message, or of another thread). */
export function itemOfQuestionMessage(
  db: Database,
  messageId: string,
  threadId: string,
): string | undefined {
  return (
    db
      .query<{ i: string }, [string, string]>(
        "SELECT item_id AS i FROM item_questions WHERE message_id = ? AND thread_id = ?",
      )
      .get(messageId, threadId)?.i ?? undefined
  );
}

/** Forget every question message of one item (it resumed or started a new run: those questions are answered or stale). */
export function clearQuestionLinks(db: Database, itemId: string): void {
  db.query("DELETE FROM item_questions WHERE item_id = ?").run(itemId);
}

/** Forget the question messages of the goal's items that ended for good (a settled item is never answered again). */
export function clearSettledQuestionLinks(db: Database, goalId: string): void {
  db.query(
    `DELETE FROM item_questions WHERE item_id IN (
       SELECT id FROM owned_tasks WHERE parent_id = ? AND status IN ('completed', 'failed', 'cancelled'))`,
  ).run(goalId);
}
