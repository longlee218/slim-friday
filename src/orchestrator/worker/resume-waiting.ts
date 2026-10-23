import type { Database } from "bun:sqlite";
import { redactClip } from "../../observability/redact";
import { clearQuestionLinks } from "../../storage/item-question-store";
import { clearResultKind, getItem, resetAttempt } from "../../storage/owned-item-store";
import { threadOfTask } from "../../storage/owned-task-store";
import { latestTurnOfTask } from "../../storage/run-store";
import { appendEvent } from "../../storage/thread-event-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { messageRef } from "../messages/message-ref";
import { postItemMessage } from "../messages/task-messages";

/* A goal item in `waiting_user` has no run (its run ended with a question or no report). The owner's answer brings it
   back: the item goes `ready` and the next dispatch pass resumes its session with the answer as the prompt. The same holds
   for an item held by the worker's own blocker (`Report blocker`, result kind BLOCKED) when the OWNER answers the teammate's
   `ask_owner` about it: the answer is the unblocking the worker asked for. */

/** Chars of the answer stored in the `answer` event (and sent to the resumed session). */
const ANSWER_CHARS = 600;

/**
 * Resume a `waiting_user` item with an answer. One transaction: item -> `ready` plus an `answer` event that names the turn
 * it continues (`afterTurn`: the next start reads it as an unread note, like a `retry`). `by` = who answered: an `owner`
 * answer is news the teammate reads, a `teammate` answer (its own Orchestrate steer) is only a record. Returns false when the item is not
 * `waiting_user` (nothing changes). The caller runs a dispatch pass.
 */
export function resumeWaiting(
  db: Database,
  itemId: string,
  text: string,
  by: "owner" | "teammate",
): boolean {
  return db.transaction(() => {
    const it = getItem(db, itemId);
    if (!it?.parentId) return false;
    // A blocker-held item resumes on the owner's reply only; a failure or NEEDS_PLANNING hold stays the teammate's call (retry).
    const blockerHold = it.status === "blocked" && it.resultKind === "BLOCKED" && by === "owner";
    if (it.status !== "waiting_user" && !blockerHold) return false;
    if (!moveTaskTo(db, itemId, "ready")) return false;
    if (blockerHold) {
      resetAttempt(db, itemId); // like a teammate retry: a fresh automatic-resume budget
      clearResultKind(db, itemId); // no longer held
    }
    clearQuestionLinks(db, itemId); // answered: an older question message must not answer a later question of the item
    const messageId = postItemMessage(db, itemId, by, "answer", text); // the full answer; the event keeps a short copy
    appendEvent(db, {
      id: `answer:${itemId}:${crypto.randomUUID()}`,
      threadId: threadOfTask(db, itemId) ?? "",
      taskId: it.parentId,
      itemId,
      kind: "answer",
      payload: {
        ...(messageId && { messageId: messageRef(messageId) }),
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
