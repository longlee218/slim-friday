import type { Clock } from "../ports/clock";

/**
 * Stream watchdog of one run: `onIdle` fires when no event came for `idleMs` while nothing long is running
 * (`busy()`: an open tool call or background task). While busy, it only waits another `idleMs`.
 */
export class StreamWatchdog {
  /** Cancels the pending timer. */
  private cancel?: () => void;
  /** Set by `stop`; no timer re-arms then. */
  private stopped = false;

  constructor(
    private clock: Clock,
    private idleMs: number,
    private busy: () => boolean,
    private onIdle: () => void,
  ) {}

  /** An event came: start the wait again. */
  arm(): void {
    if (this.stopped) return;
    this.cancel?.();
    this.cancel = this.clock.setTimer(this.idleMs, () => {
      if (this.stopped) return;
      if (this.busy()) this.arm();
      else this.onIdle();
    });
  }

  /** Stop watching; safe to call twice. */
  stop(): void {
    this.stopped = true;
    this.cancel?.();
  }
}
