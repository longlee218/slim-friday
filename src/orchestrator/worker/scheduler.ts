import type { ItemRow } from "../../storage/owned-item-store";

/* Pure part of the dispatch scheduler: which ready items of a goal may start now. No I/O, same input = same pick. */

/** Most items of one thread running at once. */
export const MAX_RUNNING_PER_THREAD = 2;

/** What the scheduler needs to know about a role (data of the role registry, injected so this stays pure). */
export interface RoleCaps {
  /** Most runs of the role at once in the thread; undefined = no limit of its own. */
  concurrency?: number;
  /** True = the role changes files of a location (`sideEffects: "location"`): one such run per location. */
  writer: boolean;
}

/** Location key of an item: its location name, or `*` when none was chosen (it may touch any location). */
const keyOf = (it: ItemRow): string => it.location ?? "*";

/** Two writers collide when they work in the same location, or either has no location chosen. */
const collide = (a: ItemRow, b: ItemRow): boolean =>
  keyOf(a) === "*" || keyOf(b) === "*" || keyOf(a) === keyOf(b);

/**
 * Items to start now, in order: the `ready` items in creation order (FIFO), as many as the thread cap leaves free, skipping an
 * item whose role is at its concurrency limit or whose location already has a running (or just picked) writer.
 * `roleCaps` answers for a role name; an unknown role gets no limit and is no writer.
 */
export function pickDispatchable(
  items: ItemRow[],
  roleCaps: (role: string | null) => RoleCaps,
  perThread = MAX_RUNNING_PER_THREAD,
): ItemRow[] {
  const running = items.filter((i) => i.status === "running");
  // A `waiting_user` item still holds its location and role slot: the owner's answer resumes it outside the scheduler.
  const active = [...running, ...items.filter((i) => i.status === "waiting_user")];
  const picked: ItemRow[] = [];
  for (const it of items) {
    if (it.status !== "ready") continue;
    if (running.length + picked.length >= perThread) break;
    const caps = roleCaps(it.ownerRole);
    const taken = [...active, ...picked];
    const sameRole = taken.filter((t) => t.ownerRole === it.ownerRole).length;
    if (caps.concurrency !== undefined && sameRole >= caps.concurrency) continue;
    if (caps.writer && taken.some((t) => roleCaps(t.ownerRole).writer && collide(t, it))) continue;
    picked.push(it);
  }
  return picked;
}
