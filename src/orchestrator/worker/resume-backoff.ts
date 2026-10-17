/* Backoff of an automatic resume: the earliest time (ms epoch) an item may start again. In memory only: a crash loses
   it, and the boot resume then starts at once (fine: the process was down for longer than any step). */

/** item id -> earliest start (ms epoch). */
const notBefore = new Map<string, number>();

/** The item may not start before `at`. */
export const holdUntil = (itemId: string, at: number): void => {
  notBefore.set(itemId, at);
};

/** Ms the item must still wait at `now` (0 = start now). A due entry is dropped. */
export function waitMs(itemId: string, now = Date.now()): number {
  const at = notBefore.get(itemId);
  if (at === undefined) return 0;
  if (at <= now) {
    notBefore.delete(itemId);
    return 0;
  }
  return at - now;
}

/** Forget the item's backoff entry (it left `ready`: cancelled, ended, or started). */
export const clearHold = (itemId: string): void => {
  notBefore.delete(itemId);
};
