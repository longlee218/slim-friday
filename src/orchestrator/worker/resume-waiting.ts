import type { Database } from "bun:sqlite";
import { redactClip } from "../../observability/redact";
import { clearQuestionLinks } from "../../storage/item-question-store";
import { getItem } from "../../storage/owned-item-store";
import { threadOfTask } from "../../storage/owned-task-store";
import { latestTurnOfTask } from "../../storage/run-store";
import { appendEvent } from "../../storage/thread-event-store";
import { moveTaskTo } from "../../tasks/task-resolver";

/* A goal item in `waiting_user` has no run (its run ended with a question or no report). The owner's answer brings it
   back: the item goes `ready` and the next dispatch pass resumes its session with the answer as the prompt. */

/** Chars of the answer stored in the `answer` event (and sent to the resumed session). */
const ANSWER_CHARS = 600;

/**
 * Resume a `waiting_user` item with an answer. One transaction: item -> `ready` plus an `answer` event that names the turn
 * it continues (`afterTurn`: the next start reads it as an unread note, like a `retry`). `by` = who answered: an `owner`
 * answer is news the lead reads, a `lead` answer (its own SteerTask) is only a record. Returns false when the item is not
 * `waiting_user` (nothing changes). The caller runs a dispatch pass.
 */
export function resumeWaiting(
  db: Database,
  itemId: string,
  text: string,
  by: "owner" | "lead",
): boolean {
  return db.transaction(() => {
    const it = getItem(db, itemId);
    if (!it?.parentId || it.status !== "waiting_user") return false;
    if (!moveTaskTo(db, itemId, "ready")) return false;
    clearQuestionLinks(db, itemId); // answered: an older question message must not answer a later question of the item
    appendEvent(db, {
      id: `answer:${itemId}:${crypto.randomUUID()}`,
      threadId: threadOfTask(db, itemId) ?? "",
      taskId: it.parentId,
      itemId,
      kind: "answer",
      payload: {
        key: it.itemKey,
        text: redactClip(text, ANSWER_CHARS),
        ...(text.length > ANSWER_CHARS && { clipped: true }), // the resumed session is told the text was cut
        by,
        afterTurn: latestTurnOfTask(db, itemId)?.id,
      },
    });
    return true;
  })();
}
