import { LEAD_DEBOUNCE_MS, LEAD_QUEUE_PER_THREAD } from "../../config/lead-caps";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { RunLimiter } from "../turns/run-limiter";

/*
 * Lead queue: the inputs of a thread's lead agent, one run at a time per thread. Owner messages that arrive close
 * together are merged into one input (debounce); the queue is FIFO with a cap (oldest dropped); every run takes a
 * slot of the lead pool (a full pool makes the thread wait FIFO, bounded). The runner itself is injected (the lead runner of L2a).
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

/** The lead pool: a limiter with a bounded FIFO wait (see `run-limiter.ts`). */
type LeadSlots = Pick<RunLimiter, "tryAcquire" | "acquire" | "canWait">;

/** Dependencies of the queue. */
export interface LeadQueueOptions {
  /** The lead run for one input; the next input of the thread starts only after it settles. */
  run: (input: LeadInput) => Promise<void>;
  pool?: LeadSlots;
  /** An input found the lead pool full (`full` = the waiting bound is reached, the input is refused) or the thread queue full (the oldest input is dropped). Not called without a pool for the first case. */
  onQueued?: (input: LeadInput, full: boolean) => void;
  /** True during shutdown: no new lead run starts (a freed slot is not taken). */
  stopping?: () => boolean;
  /** Quiet time (ms) after the last owner message before its merged input is queued. */
  debounceMs?: number;
  /** Longest wait (ms) from the first merged owner message; a steady stream cannot defer the input forever. Default 3x debounce. */
  maxWaitMs?: number;
  /** Most queued inputs per thread (the oldest is dropped past it). */
  cap?: number;
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
  /** Aborted by `stop`: a drain waiting for a lead slot then drops the input it holds. */
  abort: AbortController;
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
    debounceMs = LEAD_DEBOUNCE_MS,
    maxWaitMs = debounceMs * 3,
    cap = LEAD_QUEUE_PER_THREAD,
  } = o;
  const threads = new Map<string, ThreadState>();
  const stateOf = (threadId: string): ThreadState => {
    const found = threads.get(threadId);
    if (found) return found;
    const fresh: ThreadState = { queue: [], running: false, abort: new AbortController() };
    threads.set(threadId, fresh);
    return fresh;
  };
  /** Forget a thread with nothing left (bounded memory). */
  const prune = (threadId: string, s: ThreadState) => {
    if (!s.running && !s.timer && !s.queue.length) threads.delete(threadId);
  };
  /**
   * Take a lead slot. A full pool: the owner is told once (`queue`, or `queue full` when the waiting bound is reached and
   * the input is refused), then the thread waits FIFO. Announce inputs wait silently; a refused announce stays
   * undelivered in the outbox and the next announce picks it up. null = refused or stopped while waiting.
   */
  const acquire = async (input: LeadInput, signal: AbortSignal): Promise<(() => void) | null> => {
    const pool = o.pool;
    if (!pool) return () => {};
    const now = pool.tryAcquire();
    if (now) return now;
    if (input.kind === "owner") o.onQueued?.(input, !pool.canWait());
    return pool.acquire(signal);
  };
  /** Run the thread's queue one input at a time. */
  const drain = async (threadId: string, s: ThreadState) => {
    s.running = true;
    try {
      for (let input = s.queue.shift(); input; input = s.queue.shift()) {
        if (o.stopping?.()) continue; // shutdown: the input is dropped
        const signal = s.abort.signal; // a stop after this point drops the input while it waits for a slot
        const release = await acquire(input, signal);
        if (signal.aborted || o.stopping?.()) {
          release?.(); // stopped (or shutting down) while waiting for a slot: this input is dropped
          continue;
        }
        if (!release) {
          logEvent(log, "lead.pool_full", { threadId, kind: input.kind }, "warn");
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
      if (dropped?.kind === "owner") o.onQueued?.(dropped, true); // the owner is told the input was not taken
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
    s.abort.abort(); // a drain waiting for a slot drops the input it holds; a running run is aborted by the caller
    s.abort = new AbortController();
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
