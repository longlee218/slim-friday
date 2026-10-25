/**
 * A late-bound "a schedule changed" hook. The hub is built before the things that react to a change (the ticker's
 * kick, a web event publisher), so the hub gets `fire` and those subscribe once they exist.
 */
export function scheduleChangeHook() {
  const listeners = new Set<(scheduleId: string) => void>();
  return {
    /** Tell every subscriber; a subscriber that throws does not stop the others. */
    fire(scheduleId: string): void {
      for (const fn of [...listeners]) {
        try {
          fn(scheduleId);
        } catch {
          // A reaction to a change must never fail the change itself.
        }
      }
    },
    /** Subscribe; returns the function that removes it. */
    subscribe(fn: (scheduleId: string) => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** The hook `scheduleChangeHook` makes. */
export type ScheduleChangeHook = ReturnType<typeof scheduleChangeHook>;
