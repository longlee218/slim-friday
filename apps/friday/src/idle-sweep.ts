import type { BotHub, Clock, Log } from "@friday/core";

/** How often quiet sessions are closed. */
const SWEEP_MS = 60_000;

/** Close quiet sessions every minute (the next timer is set once a sweep ends). Returns the stop function. */
export function startIdleSweep(hub: BotHub, clock: Clock, log: Log): () => void {
  let stopped = false;
  let cancel = () => {};
  const tick = () => {
    cancel = clock.setTimer(SWEEP_MS, () => {
      hub
        .sweepIdle()
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
