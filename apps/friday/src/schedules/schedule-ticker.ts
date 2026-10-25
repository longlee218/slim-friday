import type { Clock, Log, ScheduleBoard } from "@friday/core";

/** How often the board checks for due schedules. */
export const SCHEDULE_TICK_MS = 15_000;

/**
 * Run `board.tick()` at once and then every 15 s (the next timer is set once a pass ends, so passes never overlap:
 * the board is not re-entrant). `kick()` asks for a pass soon; a kick during a pass runs exactly one more pass after
 * it. A failing pass is logged and the loop goes on. Returns `kick` and `stop`.
 */
export function startScheduleTicker(board: ScheduleBoard, clock: Clock, log: Log) {
  let stopped = false;
  let running = false;
  let again = false;
  let cancel = () => {};
  /** The pass in progress, so `stop` can wait for it before the db closes. */
  let current: Promise<void> = Promise.resolve();
  const arm = (ms: number) => {
    cancel();
    cancel = clock.setTimer(ms, () => void pass());
  };
  const pass = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    again = false;
    current = (async () => board.tick())().catch((err) =>
      log.error({ error: err instanceof Error ? err.message : String(err) }, "schedules.tick"),
    );
    await current;
    running = false;
    if (!stopped) arm(again ? 0 : SCHEDULE_TICK_MS);
  };
  void pass();
  return {
    /** Ask for a pass soon (right after the running one, if any). */
    kick(): void {
      if (stopped) return;
      if (running) again = true;
      else arm(0);
    },
    /** No pass starts after this; resolves once the running pass (if any) has ended. */
    async stop(): Promise<void> {
      stopped = true;
      cancel();
      await current;
    },
  };
}
