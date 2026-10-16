import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";

/*
 * Lead queue: the inputs of a thread's lead agent, one run at a time per thread. Owner messages that arrive close
 * together are merged into one input (debounce); the queue is FIFO with a cap (oldest dropped); every run takes a
 * global slot from the run limiter. The runner itself is injected (the lead runner of L2a).
 */

/** Logger of this module. */
const log = logger.child({ module: "lead-queue" });

/** One input for a lead run. */
export interface LeadInput {
  threadId: string;
  /** `owner` = owner messages (merged); `announce` = events of finished work. Queued as they come. */
  kind: "owner" | "announce";
  /** Ingress message ids merged into this input. */
  messageIds: string[];
  /** Owner text (merged messages joined by a new line). */
  text?: string;
  /** Thread event seqs an announce input stands for. */
  eventSeqs?: number[];
}

/** Slot source: the global run limiter (`tryAcquire` returns a release function, or null when full). */
export interface LeadSlots {
  tryAcquire(): (() => void) | null;
}

/** Dependencies of the queue. */
export interface LeadQueueOptions {
  /** The lead run for one input; the next input of the thread starts only after it settles. */
  run: (input: LeadInput) => Promise<void>;
  limiter?: LeadSlots;
  /** Quiet time (ms) after the last owner message before its merged input is queued. */
  debounceMs?: number;
  /** Longest wait (ms) from the first merged owner message; a steady stream cannot defer the input forever. Default 3x debounce. */
  maxWaitMs?: number;
  /** Most queued inputs per thread (the oldest is dropped past it). */
  cap?: number;
  /** Wait (ms) between attempts to get a slot when the limiter is full. */
  slotRetryMs?: number;
  /** Attempts to get a slot before the input is dropped. */
  slotAttempts?: number;
}

/** The queue API. */
export interface LeadQueue {
  /** Add an input (owner inputs are debounced and merged). */
  push(input: LeadInput): void;
  /** Drop the thread's queued and debouncing inputs and clear its timers (a running run is aborted by the caller). */
  stop(threadId: string): void;
  /** Stop every thread (shutdown). */
  stopAll(): void;
  /** Something is running, queued or debouncing for the thread. */
  busy(threadId: string): boolean;
}

/** Per-thread state. */
interface ThreadState {
  /** Merged owner input waiting for the debounce timer. */
  pending?: LeadInput;
  /** When the first message of `pending` arrived (ms epoch). */
  pendingSince?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Inputs waiting for their turn, oldest first. */
  queue: LeadInput[];
  /** One drain loop owns the thread (max 1 lead run per thread, also across a stop). */
  running: boolean;
  /** Bumped by `stop`: a drain waiting for a slot then drops the input it holds. */
  epoch: number;
}

/** Merge two owner inputs of one thread (ids and text are appended in arrival order). */
const merge = (a: LeadInput, b: LeadInput): LeadInput => ({
  ...a,
  messageIds: [...a.messageIds, ...b.messageIds],
  text: [a.text, b.text].filter(Boolean).join("\n"),
});

/** Build a lead queue. */
export function createLeadQueue(o: LeadQueueOptions): LeadQueue {
  const {
    debounceMs = 800,
    maxWaitMs = debounceMs * 3,
    cap = 10,
    slotRetryMs = 1000,
    slotAttempts = 10,
  } = o;
  const threads = new Map<string, ThreadState>();
  const stateOf = (threadId: string): ThreadState => {
    const found = threads.get(threadId);
    if (found) return found;
    const fresh: ThreadState = { queue: [], running: false, epoch: 0 };
    threads.set(threadId, fresh);
    return fresh;
  };
  /** Forget a thread with nothing left (bounded memory). */
  const prune = (threadId: string, s: ThreadState) => {
    if (!s.running && !s.timer && !s.queue.length) threads.delete(threadId);
  };
  /** Take a global slot, retrying while the limiter is full; null = gave up (or stopped meanwhile). */
  const acquire = async (s: ThreadState, epoch: number): Promise<(() => void) | null> => {
    if (!o.limiter) return () => {};
    for (let n = 0; n < slotAttempts && s.epoch === epoch; n++) {
      const release = o.limiter.tryAcquire();
      if (release) return release;
      await new Promise((r) => setTimeout(r, slotRetryMs).unref()); // a retry never keeps the process alive
    }
    return null;
  };
  /** Run the thread's queue one input at a time. */
  const drain = async (threadId: string, s: ThreadState) => {
    s.running = true;
    try {
      for (let input = s.queue.shift(); input; input = s.queue.shift()) {
        const epoch = s.epoch; // a stop after this point drops the input while it waits for a slot
        const release = await acquire(s, epoch);
        if (s.epoch !== epoch) {
          release?.(); // stopped while waiting for a slot: this input is dropped
          continue;
        }
        if (!release) {
          logEvent(log, "lead.slot_unavailable", { threadId, kind: input.kind }, "warn");
          continue;
        }
        try {
          await o.run(input);
        } catch (err) {
          logEvent(log, "lead.run_failed", { threadId, err: errText(err) }, "error");
        } finally {
          release();
        }
      }
    } finally {
      s.running = false;
      prune(threadId, s);
    }
  };
  /** Append to the FIFO (drop the oldest past the cap) and start the drain when idle. */
  const enqueue = (s: ThreadState, input: LeadInput) => {
    s.queue.push(input);
    if (s.queue.length > cap) {
      const dropped = s.queue.shift();
      logEvent(
        log,
        "lead.queue_full",
        { threadId: input.threadId, dropped: dropped?.kind },
        "warn",
      );
    }
    if (!s.running) void drain(input.threadId, s);
  };
  const stop = (threadId: string) => {
    const s = threads.get(threadId);
    if (!s) return;
    clearTimeout(s.timer);
    s.timer = undefined;
    s.pending = undefined;
    s.pendingSince = undefined;
    s.queue = [];
    s.epoch++; // a drain waiting for a slot drops the input it holds; a running run is aborted by the caller
    prune(threadId, s);
  };
  return {
    push(input) {
      const s = stateOf(input.threadId);
      if (input.kind !== "owner") return enqueue(s, input); // announces come already batched by their producer
      const now = Date.now();
      s.pendingSince = s.pending ? s.pendingSince : now;
      s.pending = s.pending ? merge(s.pending, input) : input;
      clearTimeout(s.timer);
      // Quiet time after the last message, but never past `maxWaitMs` after the first one.
      const delay = Math.min(debounceMs, Math.max(0, (s.pendingSince ?? now) + maxWaitMs - now));
      s.timer = setTimeout(() => {
        const merged = s.pending;
        s.timer = undefined;
        s.pending = undefined;
        s.pendingSince = undefined;
        if (merged) enqueue(s, merged);
      }, delay);
      s.timer.unref(); // a debounce never keeps the process alive
    },
    stop,
    stopAll() {
      for (const id of [...threads.keys()]) stop(id);
    },
    busy(threadId) {
      const s = threads.get(threadId);
      return !!s && (s.running || !!s.timer || s.queue.length > 0);
    },
  };
}
