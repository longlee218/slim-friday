import type { Clock } from "../../src";

/** A clock the test moves by hand. */
export class FakeClock implements Clock {
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  constructor(private t = 0) {}

  now(): number {
    return this.t;
  }

  setTimer(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  /** Move time forward and fire every timer that came due, in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((x) => x.live && x.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }
}
