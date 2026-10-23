import type { TeammateInput } from "./teammate-queue";

/** Per-thread state of the teammate queue. */
export interface ThreadState {
  /** Merged owner input waiting for the debounce timer. */
  pending?: TeammateInput;
  /** When the first message of `pending` arrived (ms epoch). */
  pendingSince?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Inputs waiting for their turn, oldest first. */
  queue: TeammateInput[];
  /** One drain loop owns the thread (max 1 teammate run per thread, also across a stop). */
  running: boolean;
  /** Aborted by `stop`: a drain waiting for a slot drops the input it holds. */
  abort: AbortController;
}

/** Merge two owner inputs of one thread (ids and text are appended in arrival order). */
export const merge = (a: TeammateInput, b: TeammateInput): TeammateInput => ({
  ...a,
  messageIds: [...a.messageIds, ...b.messageIds],
  text: [a.text, b.text].filter(Boolean).join("\n"),
});

/** Forget the debouncing input and its timer. */
export const clearPending = (s: ThreadState): void => {
  clearTimeout(s.timer);
  s.timer = undefined;
  s.pending = undefined;
  s.pendingSince = undefined;
};

/** The thread states of a queue: `stateOf` creates on first use, `prune` forgets a thread with nothing left. */
export function createThreadStates() {
  const threads = new Map<string, ThreadState>();
  const stateOf = (threadId: string): ThreadState => {
    const found = threads.get(threadId);
    if (found) return found;
    const fresh: ThreadState = { queue: [], running: false, abort: new AbortController() };
    threads.set(threadId, fresh);
    return fresh;
  };
  const prune = (threadId: string, s: ThreadState): void => {
    if (!s.running && !s.timer && !s.queue.length) threads.delete(threadId);
  };
  return { threads, stateOf, prune };
}
