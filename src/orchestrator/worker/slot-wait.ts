import { WORKER_SLOT_NOTICE_MS } from "../../config/run-caps";
import { logEvent, logger } from "../../observability/logger";
import type { ItemRow } from "../../storage/owned-item-store";
import { appendEvent } from "../../storage/thread-event-store";
import type { TeammateRuntime } from "../teammate/teammate-runtime";

/* Slot wait: a ready item that the full worker pool keeps from starting is shown to the teammate once, after
   `WORKER_SLOT_NOTICE_MS`. Notice only: the item keeps waiting (the age limit is the only hold). */

/** Logger of this module. */
const log = logger.child({ module: "slot-wait" });

/** When each deferred item was first seen waiting (ms epoch, in memory: a restart restarts the 60 s, harmless). */
const since = new Map<string, number>();

/**
 * The pool deferred `item` at `now`. After the notice delay one `slot_wait` event is appended and the teammate woken. The
 * event id carries the dispatch count, so the notice comes once per item dispatch even when a pass repeats it.
 */
export function noteDeferred(
  rt: TeammateRuntime,
  threadId: string,
  item: ItemRow,
  now = Date.now(),
) {
  const first = since.get(item.id) ?? now;
  since.set(item.id, first);
  if (now - first < WORKER_SLOT_NOTICE_MS) return;
  const written = appendEvent(rt.deps.db, {
    id: `slot_wait:${item.id}:${item.dispatchCount}`,
    threadId,
    taskId: item.parentId ?? item.id,
    itemId: item.id,
    kind: "slot_wait",
    payload: { key: item.itemKey, waitedSeconds: Math.round((now - first) / 1000) },
  });
  if (!written) return;
  logEvent(log, "dispatch.slot_wait", { itemId: item.id, threadId }, "warn");
  rt.announce(threadId);
}

/** The item started or is not ready any more: forget its wait. */
export const clearSlotWait = (itemId: string): void => void since.delete(itemId);

/** Ready items the full pool keeps waiting right now (`/limits` live state; counts items seen by a dispatch pass, in memory). */
export const deferredCount = (): number => since.size;
