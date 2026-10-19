import { MAX_RUNNING_PER_THREAD, PRIORITY, PRIORITY_AGING_MS } from "../../config/lead-caps";
import type { ItemRow } from "../../storage/owned-item-store";

/* Pure part of the dispatch scheduler: which ready items of a goal may start now. No I/O, same input = same pick. */

/** What the scheduler needs to know about a role (data of the role registry, injected so this stays pure). */
export interface RoleCaps {
  /** True = the role changes files of a location (`sideEffects: "location"`): one such run per location. */
  writer: boolean;
}

/** Location key of an item: its location name, or `*` when none was chosen (it may touch any location). */
const keyOf = (it: ItemRow): string => it.location ?? "*";

/** Two writers collide when they work in the same location, or either has no location chosen. */
const collide = (a: ItemRow, b: ItemRow): boolean =>
  keyOf(a) === "*" || keyOf(b) === "*" || keyOf(a) === keyOf(b);

/**
 * Items to start now, in order: the `ready` items by priority (highest first; one that waited over `PRIORITY_AGING_MS` counts as urgent), then creation order (FIFO; the sort is stable),
 * as many as the thread cap leaves free, skipping an
 * item whose location already has a running (or just picked) writer.
 * `roleCaps` answers for a role name; an unknown role is no writer. `occupied` marks an item whose location is held by a
 * force-closed run that may still write (a zombie claim): that writer is skipped like a collision, so it neither starts
 * nor uses a slot of the cap, and the items behind it still run. A running item is never preempted: priority only orders
 * what waits for a free slot or location.
 */
export function pickDispatchable(
  items: ItemRow[],
  roleCaps: (role: string | null) => RoleCaps,
  perThread = MAX_RUNNING_PER_THREAD,
  occupied: (it: ItemRow) => boolean = () => false,
  now = Date.now(),
): ItemRow[] {
  const running = items.filter((i) => i.status === "running");
  // A `waiting_user` item has no run (its run ended): it holds no location and no slot. The owner's answer re-queues
  // it as `ready`, and it then competes for its location like any other item.
  const active = running;
  const picked: ItemRow[] = [];
  // Aging: an item that waited longer than `PRIORITY_AGING_MS` counts as urgent, so a stream of newer urgent items cannot starve it.
  const urgency = (i: ItemRow): number =>
    now - i.lastProgressAt > PRIORITY_AGING_MS ? PRIORITY.urgent : i.priority;
  const byUrgency = items
    .filter((i) => i.status === "ready")
    .sort((a, b) => urgency(b) - urgency(a));
  for (const it of byUrgency) {
    if (running.length + picked.length >= perThread) break;
    const caps = roleCaps(it.ownerRole);
    const taken = [...active, ...picked];
    if (caps.writer && occupied(it)) continue;
    if (caps.writer && taken.some((t) => roleCaps(t.ownerRole).writer && collide(t, it))) continue;
    picked.push(it);
  }
  return picked;
}
