import type { BotHub, Clock, Log } from "@friday/core";

/** How often quiet sessions are closed. */
const SWEEP_MS = 60_000;

/**
 * Every minute (the next timer is set once a sweep ends): close quiet sessions, then the card sweep (one
 * reminder per card waiting 4 h; requeue runs whose card was answered before a crash). Returns the stop function.
 */
export function startIdleSweep(hub: BotHub, clock: Clock, log: Log): () => void {
  let stopped = false;
  let cancel = () => {};
  const tick = () => {
    cancel = clock.setTimer(SWEEP_MS, () => {
      hub
        .sweepIdle()
        .then(() => hub.sweepCards())
        .catch((err) =>
          log.error({ error: err instanceof Error ? err.message : String(err) }, "sweep"),
        )
        .finally(() => !stopped && tick());
    });
  };
  tick();
  return () => {
    stopped = true;
    cancel();
  };
}
