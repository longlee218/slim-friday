/** Time source; tests drive it by hand. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Run `fn` once after `ms`; returns a function that cancels it. */
  setTimer(ms: number, fn: () => void): () => void;
}
