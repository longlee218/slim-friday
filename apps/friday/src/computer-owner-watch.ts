import { type Clock, OWNER_HOLDER, type Store } from "@friday/core";
import { type Every, realEvery } from "@friday/tools";

/** How often the engine looks for owner holds that ended. */
export const OWNER_WATCH_MS = 10_000;

/** What the owner-control watch needs. */
export interface OwnerWatchDeps {
  holds: Store["computerHolds"];
  clock: Clock;
  /** An owner hold on `computer` was seen live before and is not live now (given back, or lapsed). */
  onEnded: (computer: string) => Promise<void>;
}

/**
 * Every 10 s, compare the computers the owner holds now with the last look: one that dropped out ended (a lapsed
 * hold of a vanished owner looks the same as a give-back, and `onEnded` is idempotent). Returns the stop.
 */
export function watchOwnerControl(d: OwnerWatchDeps, every: Every = realEvery): () => void {
  let seen = new Set<string>();
  let busy = false;
  return every(OWNER_WATCH_MS, () => {
    if (busy) return;
    busy = true;
    d.holds
      .live(d.clock.now())
      .then(async (rows) => {
        const now = new Set(
          rows
            .filter((r) => r.kind === "input" && r.holder === OWNER_HOLDER)
            .map((r) => r.computer),
        );
        const ended = [...seen].filter((c) => !now.has(c));
        seen = now;
        for (const c of ended) await d.onEnded(c).catch(() => undefined);
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  });
}
