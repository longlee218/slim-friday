import type { Database } from "bun:sqlite";
import { pendingNews } from "./lead-events";
import type { LeadInput } from "./lead-queue";

/* Announce: worker news (result, failure, question, blocked) wakes the thread's lead. News that comes close together is
   batched: one timer per thread, and when it fires ONE announce input is queued (the run reads all the news then). */

/** Quiet window (ms) that batches the news of a thread into one lead run. */
const ANNOUNCE_WINDOW_MS = 2000;

/** The announcer: `notify` after an event was appended; `stopAll` at shutdown. */
export interface Announcer {
  notify(threadId: string): void;
  /** Drop the thread's waiting batch (`/stop`). */
  cancel(threadId: string): void;
  stopAll(): void;
}

/** Build the announcer over the db (it reads the undelivered news) and the lead queue's `push`. */
export function createAnnouncer(o: {
  db: Database;
  push: (i: LeadInput) => void;
  windowMs?: number;
}): Announcer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    notify(threadId) {
      if (timers.has(threadId)) return; // a batch is already waiting
      const t = setTimeout(() => {
        timers.delete(threadId);
        if (pendingNews(o.db, threadId).length)
          o.push({ threadId, kind: "announce", messageIds: [] });
      }, o.windowMs ?? ANNOUNCE_WINDOW_MS);
      t.unref(); // a batch never keeps the process alive
      timers.set(threadId, t);
    },
    cancel(threadId) {
      clearTimeout(timers.get(threadId));
      timers.delete(threadId);
    },
    stopAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
