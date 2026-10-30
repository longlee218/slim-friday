import type { Clock } from "../ports/clock";
import type { Log } from "../ports/log";

/** The marks of a run, each in ms from the claim. */
export type TimingMark = "openMs" | "turnBuildMs" | "firstEventMs" | "firstTextMs";

/** Collects a run's marks; `finish()` writes them once. */
export interface RunTiming {
  /** Records `name` as the time since the claim; only its first call counts. */
  mark(name: TimingMark): void;
  /** Writes the single `run.timing` line (ids and ms only); later calls do nothing; a failing log is ignored. */
  finish(): void;
}

/** Starts timing a run now (the claim). Without a log the tracker does nothing. */
export function startTiming(
  clock: Pick<Clock, "now">,
  log: Log | undefined,
  wakeId: string,
  scope: string,
): RunTiming {
  const t0 = clock.now();
  const marks: Partial<Record<TimingMark, number>> = {};
  let done = false;
  return {
    mark(name) {
      marks[name] ??= clock.now() - t0;
    },
    finish() {
      if (done) return;
      done = true;
      try {
        log?.info({ event: "run.timing", wakeId, scope, ...marks }, "run.timing");
      } catch {
        // A measurement must never change how a run ends.
      }
    },
  };
}
