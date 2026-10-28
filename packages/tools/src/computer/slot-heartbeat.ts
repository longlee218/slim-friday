import { type ComputerHold, type LeaseDeps, renewSlot } from "@friday/core";

/** Renew interval of a held slot: a third of its 120 s TTL, so one missed beat never lets it lapse. */
export const HEARTBEAT_MS = 40_000;
/** No tool call for this long stops the beats (a parked or abandoned session must not keep a slot forever). */
export const HEARTBEAT_IDLE_MS = 600_000;

/** Runs `fn` every `ms` until the returned stop is called. */
export type Every = (ms: number, fn: () => void) => () => void;

/** The real scheduler: an interval that never keeps the process alive. */
export const realEvery: Every = (ms, fn) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

/** Keeps a slot alive between tool calls while the session holds it. */
export interface SlotHeartbeat {
  /** Beat for this hold (replaces any earlier beat). */
  start(hold: ComputerHold): void;
  /** Stop beating (slot lost or released). */
  stop(): void;
  /** A tool call happened now (resets the idle limit). */
  touch(): void;
}

/**
 * Renew `hold` every 40 s while it is held. Stops for good when a renew returns false (released, e.g. by the
 * run-end release, or taken over) or throws, and after 10 min without a tool call. Never throws.
 */
export function slotHeartbeat(deps: LeaseDeps, every: Every = realEvery): SlotHeartbeat {
  let stopCurrent: (() => void) | undefined;
  let lastCall = deps.clock.now();
  const stop = () => {
    stopCurrent?.();
    stopCurrent = undefined;
  };
  return {
    start(hold) {
      stop();
      let busy = false;
      const cancel = every(HEARTBEAT_MS, () => {
        // Only this beat may end itself: a newer one may have replaced it.
        const end = () => (stopCurrent === cancel ? stop() : cancel());
        if (deps.clock.now() - lastCall > HEARTBEAT_IDLE_MS) return end();
        if (busy) return;
        busy = true;
        renewSlot(deps, hold)
          .then(
            (ok) => {
              if (!ok) end();
            },
            () => end(),
          )
          .finally(() => {
            busy = false;
          });
      });
      stopCurrent = cancel;
    },
    stop,
    touch() {
      lastCall = deps.clock.now();
    },
  };
}
