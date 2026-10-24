/** One hint that rows changed; the rows are already written, a hint only makes a worker look sooner. */
export type RunHint =
  | { kind: "newRun"; wakeId: string }
  | { kind: "steer"; wakeId: string }
  | { kind: "cardAnswered"; cardId: string }
  | { kind: "cancel"; wakeIds: string[] }
  | { kind: "configChanged" };

/**
 * Tells the workers that something claimable or relevant was written. Best effort: a lost hint costs at
 * most one fallback scan, so callers never wait on it and never fail because of it.
 */
export interface RunHints {
  /** A queued run was stored. */
  newRun(wakeId: string): void;
  /** A steering row was bound to run `wakeId`. */
  steer(wakeId: string): void;
  /** Card `cardId` was answered or withdrawn; its run is queued again. */
  cardAnswered(cardId: string): void;
  /** These runs were cancelled; their holders should stop. */
  cancel(wakeIds: string[]): void;
  /** The config files changed. */
  configChanged(): void;
}

/** Hints delivered to listeners in this process (tests and the in-process worker). */
export class InProcessHints implements RunHints {
  /** Who hears each hint. */
  private listeners = new Set<(h: RunHint) => void>();

  /** Listen to every hint; returns a function that stops listening. */
  on(listener: (h: RunHint) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  newRun(wakeId: string): void {
    this.emit({ kind: "newRun", wakeId });
  }
  steer(wakeId: string): void {
    this.emit({ kind: "steer", wakeId });
  }
  cardAnswered(cardId: string): void {
    this.emit({ kind: "cardAnswered", cardId });
  }
  cancel(wakeIds: string[]): void {
    this.emit({ kind: "cancel", wakeIds });
  }
  configChanged(): void {
    this.emit({ kind: "configChanged" });
  }

  /** Give the hint to every listener; a listener that throws must not stop the writer or the others. */
  private emit(h: RunHint): void {
    for (const l of this.listeners) {
      try {
        l(h);
      } catch {
        // A hint is best effort; the fallback scan finds the rows anyway.
      }
    }
  }
}
