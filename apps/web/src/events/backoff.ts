/** Reconnect delay in ms for the Nth failed attempt (0-based): 1 s, 2 s, 4 s ... capped at 30 s. */
export function nextBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30000);
}
