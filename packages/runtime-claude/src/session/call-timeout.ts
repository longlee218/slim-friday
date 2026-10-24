/** A note call (extraction or consolidation) that has not answered by then is given up. */
export const NOTE_CALL_TIMEOUT_MS = 120_000;

/** An abort controller that fires after `ms` (the timer does not keep the process alive). */
export function timeoutController(ms: number): AbortController {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms).unref?.();
  return ac;
}
