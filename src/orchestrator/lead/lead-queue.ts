import { LEAD_DEBOUNCE_MS, LEAD_QUEUE_PER_THREAD } from "../../config/lead-caps";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { RunLimiter } from "../turns/run-limiter";
import { clearPending, createThreadStates, merge, type ThreadState } from "./lead-queue-state";

/*
 * Lead queue: the inputs of a thread's lead agent, one run at a time per thread. Owner messages close together are
 * merged (debounce); FIFO with a cap (oldest dropped); every run takes a lead-pool slot (a full pool makes the
 * thread wait FIFO, bounded). The runner is injected.
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
  /** The lead pool or the thread queue is full (`full` = input refused / oldest dropped, not just waiting). */
  onQueued?: (input: LeadInput, full: boolean) => void;
  /** An `announce` input was dropped (lead pool full, thread queue full): its news is still undelivered. */
  onDropped?: (input: LeadInput) => void;
  /** An `owner` input was dropped on purpose (`/stop`, thread queue cap, pool refusal): its message must never be replayed. */
  onDiscarded?: (input: LeadInput) => void;
  /** True during shutdown: no new lead run starts (a freed slot is not taken). */
  stopping?: () => boolean;
  /** Quiet time (ms) after the last owner message before its merged input is queued. */
  debounceMs?: number;
  /** Longest wait (ms) from the first merged owner message (default 3x debounce). */
  maxWaitMs?: number;
  /** Most queued owner inputs per thread (the oldest is dropped past it; announces never count and never evict one). */
  cap?: number;
}

/** The queue API. */
export interface LeadQueue {
  /** Add an input (owner inputs are debounced and merged). */
  push(input: LeadInput): void;
  /** Drop the thread's queued and debouncing inputs (a running run is aborted by the caller). */
  stop(threadId: string): void;
  /** Stop every thread (shutdown). */
  stopAll(): void;
  /** Something is running, queued or debouncing for the thread. */
  busy(threadId: string): boolean;
}

/** Build a lead queue. */
export function createLeadQueue(o: LeadQueueOptions): LeadQueue {
  const {
    debounceMs = LEAD_DEBOUNCE_MS,
    maxWaitMs = debounceMs * 3,
    cap = LEAD_QUEUE_PER_THREAD,
  } = o;
  const { threads, stateOf, prune } = createThreadStates();
  /** Set by `stopAll`: a shutdown keeps the owner's unanswered messages for the boot replay, `/stop` does not. */
  let shuttingDown = false;
  const discards = () => !shuttingDown && !o.stopping?.();
  /**
   * Take a lead slot. A full pool: the owner is told once (`queue full` when the waiting bound is reached and the
   * input is refused), then the thread waits FIFO. Announces wait silently; a refused one stays in the outbox.
   * null = refused or stopped while waiting.
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
        const signal = s.abort.signal; // a stop from here on drops the input while it waits for a slot
        const release = await acquire(input, signal);
        if (signal.aborted || o.stopping?.()) {
          release?.(); // stopped or shutting down while waiting: drop the input
          // `/stop` discards the owner's message for good; a shutdown keeps it for the boot replay.
          if (input.kind === "owner" && discards()) o.onDiscarded?.(input);
          continue;
        }
        if (!release) {
          logEvent(log, "lead.pool_full", { threadId, kind: input.kind }, "warn");
          if (input.kind === "announce") o.onDropped?.(input);
          else o.onDiscarded?.(input); // the owner was told "not taken"
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
  /**
   * Append to the FIFO and start the drain when idle. Announces are deduped (one queued announce reads all the news) and
   * stand outside the cap; past the cap the oldest OWNER input is dropped.
   */
  const enqueue = (s: ThreadState, input: LeadInput) => {
    if (input.kind === "announce" && s.queue.some((q) => q.kind === "announce")) return;
    s.queue.push(input);
    if (s.queue.filter((q) => q.kind === "owner").length > cap) {
      const at = s.queue.findIndex((q) => q.kind === "owner");
      const [dropped] = s.queue.splice(at, 1);
      logEvent(
        log,
        "lead.queue_full",
        { threadId: input.threadId, dropped: dropped?.kind },
        "warn",
      );
      if (dropped) {
        o.onQueued?.(dropped, true); // the owner is told it was not taken
        o.onDiscarded?.(dropped);
      }
    }
    if (!s.running) void drain(input.threadId, s);
  };
  const stop = (threadId: string) => {
    const s = threads.get(threadId);
    if (!s) return;
    // `/stop` discards the owner's unanswered messages; a shutdown (`stopAll`) keeps them undelivered for the boot replay.
    if (discards())
      for (const i of [...(s.pending ? [s.pending] : []), ...s.queue])
        if (i.kind === "owner") o.onDiscarded?.(i);
    clearPending(s);
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
        clearPending(s);
        if (merged) enqueue(s, merged);
      }, delay);
      s.timer.unref(); // a debounce never keeps the process alive
    },
    stop,
    stopAll() {
      shuttingDown = true;
      for (const id of [...threads.keys()]) stop(id);
    },
    busy(threadId) {
      const s = threads.get(threadId);
      return !!s && (s.running || !!s.timer || s.queue.length > 0);
    },
  };
}
