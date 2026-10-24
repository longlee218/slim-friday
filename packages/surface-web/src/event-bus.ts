import type { FridayEvent } from "@friday/contracts";

/** One event with its bus id (ids start after the bus's start id and grow by 1). */
export interface BusItem {
  id: number;
  event: FridayEvent;
}

/** One live subscriber: events waiting to be read, and the reader's wake-up. */
interface Subscriber {
  /** Replayed events; they never count toward the overflow limit. */
  replay: BusItem[];
  /** Live events queued since subscribe; the overflow limit counts these. */
  queue: BusItem[];
  /** Set while the reader waits for the next item. */
  pending?: (r: IteratorResult<BusItem>) => void;
  /** No more items after the queues drain. */
  closed: boolean;
  /** Removes the abort listener. */
  detach?: () => void;
}

/**
 * In-memory event bus for the SSE stream. Keeps the last `size` events so a tab that reconnects
 * with `Last-Event-ID` gets what it missed; when the buffer no longer covers it (or the engine
 * restarted), it gets one `resync` and refetches. A subscriber that falls `size` events behind
 * gets `resync` and is closed, so a stuck tab cannot grow memory.
 */
export class EventBus {
  /** The last `size` events, oldest first. */
  private buffer: BusItem[] = [];
  private last: number;
  private subs = new Set<Subscriber>();

  /**
   * `size`: events kept for replay and the most a subscriber may leave unread.
   * `startId`: the id before the first event; a later boot starts higher, so an id from a
   * previous run is older than the buffer and gets a `resync` instead of a silent gap.
   */
  constructor(
    private readonly size = 500,
    startId = 0,
  ) {
    this.last = startId;
  }

  /** Store the event, hand it to every subscriber and return its id. */
  publish(event: FridayEvent): number {
    const item: BusItem = { id: ++this.last, event };
    this.buffer.push(item);
    if (this.buffer.length > this.size) this.buffer.shift();
    for (const sub of this.subs) {
      sub.queue.push(item);
      // Too far behind: drop the backlog, send one resync, close.
      if (sub.queue.length >= this.size) {
        sub.replay = [];
        sub.queue = [{ id: this.last, event: { type: "resync" } }];
        this.close(sub);
      }
      this.flush(sub);
    }
    return item.id;
  }

  /** Id of the newest event (the start id before the first). */
  lastId(): number {
    return this.last;
  }

  /** Number of open subscribers. */
  subscriberCount(): number {
    return this.subs.size;
  }

  /**
   * Events after `lastEventId` (replayed when still held, else one `resync`), then live ones.
   * No id: live only. Registers at call time, ends when `signal` aborts.
   * Single reader: one pending `next()` at a time (as `for await` does); no resolver queue.
   */
  subscribe(lastEventId: number | undefined, signal: AbortSignal): AsyncIterable<BusItem> {
    const sub: Subscriber = { replay: [], queue: [], closed: false };
    if (lastEventId !== undefined) {
      const oldestHeld = this.last - this.buffer.length + 1;
      if (lastEventId >= oldestHeld - 1 && lastEventId <= this.last) {
        sub.replay = this.buffer.filter((i) => i.id > lastEventId);
      } else {
        sub.replay = [{ id: this.last, event: { type: "resync" } }];
      }
    }
    if (signal.aborted) {
      sub.replay = [];
      sub.closed = true;
    } else {
      this.subs.add(sub);
      const onAbort = () => {
        sub.replay = [];
        sub.queue = [];
        this.close(sub);
        this.flush(sub);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      sub.detach = () => signal.removeEventListener("abort", onAbort);
    }
    const iterator: AsyncIterableIterator<BusItem> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () =>
        new Promise((resolve) => {
          sub.pending = resolve;
          this.flush(sub);
        }),
      // Ends the stream; a pending next() resolves as done.
      return: async () => {
        sub.replay = [];
        sub.queue = [];
        this.close(sub);
        this.flush(sub);
        return { done: true, value: undefined };
      },
    };
    return iterator;
  }

  /** Stop feeding a subscriber and drop its abort listener; queued items stay readable. */
  private close(sub: Subscriber): void {
    sub.closed = true;
    this.subs.delete(sub);
    sub.detach?.();
  }

  /** Answer the reader's pending next() from the queues, or with done once closed and drained. */
  private flush(sub: Subscriber): void {
    if (!sub.pending) return;
    const item = sub.replay.shift() ?? sub.queue.shift();
    if (item) {
      const resolve = sub.pending;
      sub.pending = undefined;
      resolve({ done: false, value: item });
    } else if (sub.closed) {
      const resolve = sub.pending;
      sub.pending = undefined;
      resolve({ done: true, value: undefined });
    }
  }
}
