import { MAX_PENDING_STEERS } from "../../runtime/run-input-channel";

/* Steers held for a task whose streaming run has not registered its input yet (it is starting), keyed by task key. */

/** One held steer: its `run_messages` ref and text. */
export interface HeldSteer {
  ref?: string;
  text: string;
}

/** Build an empty held-steer table. */
export function createHeldSteers() {
  /** taskKey -> held steers of that task and the thread they came from. */
  const held = new Map<string, { threadId: string; items: HeldSteer[] }>();
  return {
    /** Hold a steer for `key`; false when `key` already holds the most a task may. */
    add(key: string, threadId: string, item: HeldSteer): boolean {
      const items = held.get(key)?.items ?? [];
      if (items.length >= MAX_PENDING_STEERS) return false;
      held.set(key, { threadId, items: [...items, item] });
      return true;
    },
    /** Remove and return what `key` holds, in arrival order. */
    take(key: string): HeldSteer[] {
      const items = held.get(key)?.items ?? [];
      held.delete(key);
      return items;
    },
  };
}
