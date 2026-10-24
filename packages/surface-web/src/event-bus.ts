import type { FridayEvent } from "@friday/contracts";

/** One event with its bus id (ids start at 1 and grow by 1). */
export interface BusItem {
  id: number;
  event: FridayEvent;
}

/** One live subscriber: events waiting to be read, and the reader's wake-up. */
interface Subscriber {
  queue: BusItem[];
  /** Set while the reader waits for the next item. */
  wake?: () => void;
  /** No more items after the queue drains. */
  closed: boolean;
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
  private last = 0;
  private subs = new Set<Subscriber>();

  /** `size`: events kept for replay and the most a subscriber may leave unread. */
  constructor(private readonly size = 500) {}

  /** Store the event, hand it to every subscriber and return its id. */
  publish(event: FridayEvent): number {
    const item: BusItem = { id: ++this.last, event };
    this.buffer.push(item);
    if (this.buffer.length > this.size) this.buffer.shift();
    for (const sub of this.subs) {
      sub.queue.push(item);
      // Too far behind: drop the backlog, send one resync, close.
      if (sub.queue.length >= this.size) {
        sub.queue = [{ id: this.last, event: { type: "resync" } }];
        sub.closed = true;
        this.subs.delete(sub);
      }
      sub.wake?.();
    }
    return item.id;
  }

  /** Id of the newest event (0 before the first). */
  lastId(): number {
    return this.last;
  }

  /**
   * Events after `lastEventId` (replayed when still held, else one `resync`), then live ones.
   * No id: live only. Registers at call time, ends when `signal` aborts.
   */
  subscribe(lastEventId: number | undefined, signal: AbortSignal): AsyncIterable<BusItem> {
    const sub: Subscriber = { queue: [], closed: signal.aborted };
    if (!sub.closed) {
      if (lastEventId !== undefined) {
        const oldestHeld = this.last - this.buffer.length + 1;
        if (lastEventId >= oldestHeld - 1 && lastEventId <= this.last) {
          sub.queue = this.buffer.filter((i) => i.id > lastEventId);
        } else {
          sub.queue = [{ id: this.last, event: { type: "resync" } }];
        }
      }
      this.subs.add(sub);
      signal.addEventListener(
        "abort",
        () => {
          sub.closed = true;
          this.subs.delete(sub);
          sub.wake?.();
        },
        { once: true },
      );
    }
    return this.read(sub);
  }

  /** Yield queued items, waiting for more, until the subscriber closes and drains. */
  private async *read(sub: Subscriber): AsyncGenerator<BusItem> {
    try {
      while (true) {
        const next = sub.queue.shift();
        if (next) {
          yield next;
        } else if (sub.closed) {
          return;
        } else {
          await new Promise<void>((resolve) => {
            sub.wake = resolve;
          });
          sub.wake = undefined;
        }
      }
    } finally {
      this.subs.delete(sub);
    }
  }
}
