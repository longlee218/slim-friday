import { ITEM_MAX_AGE_MS } from "../../config/resilience-caps";
import { logEvent, logger } from "../../observability/logger";
import { agedItems } from "../../storage/item-age-store";
import { getItem, setResultKind } from "../../storage/owned-item-store";
import { appendEvent, holdCount } from "../../storage/thread-event-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import type { LeadRuntime } from "../lead/lead-runtime";
import { AUTHOR_SYSTEM } from "../messages/message-kinds";
import { messageRef } from "../messages/message-ref";
import { postItemMessage } from "../messages/task-messages";
import { runOfTask } from "../run/live-runs";
import { clearHold } from "./resume-backoff";

/* The item age limit: a goal item older than `ITEM_MAX_AGE_MS` (1 man-day) is held for the lead, who retries it (a fresh
   window) or cancels it. A live run is aborted with cause `item_age` (the failure policy holds it as a REAL failure, no
   auto-resume); an item with no live run (ready, backoff, waiting for the owner) is held right here. */

/** Logger of this module. */
const log = logger.child({ module: "item-age" });

/** One sweep at `now`: abort or hold every item past the limit. Returns how many items it acted on. */
export function sweepItemAge(
  rt: LeadRuntime,
  now = Date.now(),
  maxAgeMs = ITEM_MAX_AGE_MS,
): number {
  const { db } = rt.deps;
  let acted = 0;
  for (const { id, threadId, clockStart } of agedItems(db, now, maxAgeMs)) {
    const ageHours = Math.round((now - clockStart) / 360_000) / 10;
    const live = runOfTask(id);
    if (live) {
      // Already aborted by someone (owner stop, stale watchdog): the run's end decides; this item is checked again next tick.
      if (live.abortCause || live.ac.signal.aborted) continue;
      live.abortCause = "item_age"; // before the abort: the run's end reads the cause
      live.ac.abort();
      logEvent(log, "item.age_exceeded", { itemId: id, ageHours, action: "abort" }, "warn");
      acted++;
      continue;
    }
    const item = getItem(db, id);
    if (!item?.parentId || !moveTaskTo(db, id, "blocked")) continue;
    setResultKind(db, id, "FAILED");
    clearHold(id); // a backoff entry of the held item must not outlive it
    const messageId = postItemMessage(
      db,
      id,
      AUTHOR_SYSTEM,
      "note",
      `The app held this item: it ran past the age limit (${ageHours} h without a result). Waiting for the lead to retry or cancel.`,
    );
    appendEvent(db, {
      id: `failure:${id}:${item.dispatchCount}:${holdCount(db, id)}`, // the count: a second hold is its own event
      threadId,
      taskId: item.parentId,
      itemId: id,
      kind: "failure",
      // Same shape as the end event of a held run (worker-end-event.ts), so the lead reads both alike.
      payload: {
        ...(messageId && { messageId: messageRef(messageId) }),
        key: item.itemKey,
        status: "blocked",
        resultKind: "FAILED",
        class: "real",
        cause: "item_age",
        attempt: item.attempt,
      },
    });
    logEvent(log, "item.age_exceeded", { itemId: id, ageHours, action: "hold" }, "warn");
    rt.announce(threadId);
    acted++;
  }
  return acted;
}
