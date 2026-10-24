import type { RunHint, RunHints } from "@friday/core";
import type { HintMessage } from "./ipc-protocol";

/**
 * Run hints sent over IPC: main broadcasts them to every worker, a worker sends them to main (which
 * broadcasts them). Best effort like every hint: a send that fails is dropped (the fallback scan finds the rows).
 */
export class IpcHints implements RunHints {
  /** `send` delivers one hint message; it may throw (a closed channel). */
  constructor(private send: (m: HintMessage) => void) {}

  /** A queued run was stored. */
  newRun(wakeId: string): void {
    this.post({ t: "hint", kind: "run", ids: [wakeId] });
  }
  /** A steering row was bound to run `wakeId`. */
  steer(wakeId: string): void {
    this.post({ t: "hint", kind: "steer", ids: [wakeId] });
  }
  /** Card `cardId` was answered or withdrawn. */
  cardAnswered(cardId: string): void {
    this.post({ t: "hint", kind: "card", ids: [cardId] });
  }
  /** These runs were cancelled. */
  cancel(wakeIds: string[]): void {
    this.post({ t: "hint", kind: "cancel", ids: wakeIds });
  }
  /** The config files changed. */
  configChanged(): void {
    this.post({ t: "hint", kind: "config" });
  }

  /** Send, never throw. */
  private post(m: HintMessage): void {
    try {
      this.send(m);
    } catch {
      // Best effort: a lost hint costs at most one fallback scan.
    }
  }
}

/** The core hints one IPC hint message stands for (a worker emits them to its runner). */
export function toRunHints(m: HintMessage): RunHint[] {
  const ids = m.ids ?? [];
  switch (m.kind) {
    case "run":
      // A run hint without ids still means "look now".
      return ids.length > 0
        ? ids.map((wakeId) => ({ kind: "newRun", wakeId }))
        : [{ kind: "scan" }];
    case "steer":
      return ids.map((wakeId) => ({ kind: "steer", wakeId }));
    case "card":
      return ids.map((cardId) => ({ kind: "cardAnswered", cardId }));
    case "cancel":
      return [{ kind: "cancel", wakeIds: ids }];
    case "config":
      return [{ kind: "configChanged" }];
  }
}
