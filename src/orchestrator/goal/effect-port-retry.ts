import type { Database } from "bun:sqlite";
import { redactClip } from "../../observability/redact";
import { clearResultKind, getItem, isHeld, resetAttempt } from "../../storage/owned-item-store";
import { latestTurnOfTask } from "../../storage/run-store";
import { appendEvent } from "../../storage/thread-event-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { goalOverBudget } from "../budget/task-budget";
import { AUTHOR_LEAD } from "../messages/message-kinds";
import { messageRef } from "../messages/message-ref";
import { postItemMessage } from "../messages/task-messages";
import { cancelDependents, settleGoal } from "../worker/goal-settle";
import type { EffectPort } from "./effect-port";
import { cancelSet } from "./effect-port-queries";

/** Chars of the lead's retry note stored in the `retry` event. */
const NOTE_CHARS = 600;

/** The retry part of the db-backed port (kept out of `effect-port-db.ts`, which is at its size limit). */
export function createRetryPort(db: Database, threadId: string): Pick<EffectPort, "retry"> {
  return {
    // One transaction: ready + fresh resume budget + the `retry` event (it names the turn the retry continues, so the next
    // start knows the note is unread). `not_held` when the item is not held any more, `over_budget` when the goal's budget is used.
    retry: (taskId, note) =>
      db.transaction(() => {
        const it = getItem(db, taskId);
        if (!it || !isHeld(it)) return "not_held";
        if (goalOverBudget(db, it.parentId ?? it.id)) return "over_budget";
        if (!moveTaskTo(db, taskId, "ready")) return "not_held";
        resetAttempt(db, taskId);
        clearResultKind(db, taskId); // no longer held: `isHeld` must not read the old FAILED
        // The note is a lead message of the item's thread (the resumed run reads it there); the event keeps a short copy.
        const messageId = note.trim()
          ? postItemMessage(db, taskId, AUTHOR_LEAD, "steer", note)
          : undefined;
        appendEvent(db, {
          id: `retry:${taskId}:${crypto.randomUUID()}`, // one event per call: a second retry with no run between must still write its note
          threadId,
          taskId: it.parentId ?? it.id,
          itemId: it.id,
          kind: "retry",
          payload: {
            ...(messageId && { messageId: messageRef(messageId) }),
            note: redactClip(note, NOTE_CHARS),
            afterTurn: latestTurnOfTask(db, taskId)?.id,
            by: "lead",
          },
        });
        return "ok" as const;
      })(),
  };
}

/**
 * `Orchestrate cancel` on a held item: the lead gives the failure up, so the item becomes `failed` (terminal), its dependents are
 * cancelled and the goal settles `failed`. Returns the ids moved, or undefined when the item is not held (the normal cancel applies).
 */
export function cancelHeld(db: Database, taskId: string): string[] | undefined {
  const it = getItem(db, taskId);
  if (!it || !isHeld(it) || !moveTaskTo(db, taskId, "failed")) return undefined;
  const ids = cancelSet(db, taskId);
  cancelDependents(db, taskId);
  settleGoal(db, it.parentId ?? it.id);
  return ids;
}
