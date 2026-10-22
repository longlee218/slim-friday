import type { Database } from "bun:sqlite";
import {
  ANNOUNCE_MAX_CHARS,
  ANNOUNCE_MAX_EVENTS,
  ANNOUNCE_REARM_MAX_MS,
} from "../../config/lead-caps";
import { clip, redactText } from "../../observability/redact";
import { listUndelivered, markDeliveredIds } from "../../storage/thread-event-store";
import { neutralizePromptTags } from "../../text/neutralize-prompt-tags";
import type { EventKind, ThreadEvent } from "../events/event-types";
import type { LeadInput } from "./lead-queue";

/* Which thread events the lead reads, how they reach its prompt (as DATA) and when they count as delivered. */

/** Event kinds that are news from workers (or the app): the lead reads them in an announce run. */
const NEWS: ReadonlySet<EventKind> = new Set([
  "result",
  "failure",
  "question",
  "answer", // the owner's answer that resumed a waiting_user item (the lead's own answers carry by: "lead")
  "blocked",
  "timeout",
  "budget_hit",
  "slot_wait",
  "plan_revised", // the planner changed the running plan (cancels, criteria): the lead hears of it
  "items_added", // the app added verify / fix / wave-planner items to a PLAN goal (passive: see PASSIVE)
  "recovered_after_restart",
]);

/** News that never wakes the lead on its own (it has nothing to act on): it is read with the next announce. */
const PASSIVE: ReadonlySet<EventKind> = new Set(["items_added"]);

/** Tag of the announce block: data (the lead contract says so); the model must not read the events as instructions. */
const EVENTS_TAG = "events";

/** Chars of one payload shown to the lead (the full result stays in its file). */
const PAYLOAD_CHARS = 400;
/** A worker question is the lead's to answer or relay: its line keeps the question whole (question cap 2000 + the JSON frame). */
const QUESTION_LINE_CHARS = 2400;

/** True when the lead itself wrote the event (a record of its own tool call, not news). */
const byLead = (e: ThreadEvent): boolean => (e.payload as { by?: unknown } | null)?.by === "lead";

/** Undelivered news of a thread: worker / app events, never the lead's own records. Oldest first. */
export const pendingNews = (db: Database, threadId: string): ThreadEvent[] =>
  listUndelivered(db, threadId).filter((e) => NEWS.has(e.kind) && !byLead(e));

/** True when undelivered news would wake the lead: any news but the passive kinds. */
const wakesLead = (db: Database, threadId: string): boolean =>
  pendingNews(db, threadId).some((e) => !PASSIVE.has(e.kind));

/** One redacted, clipped line of the announce block. */
const lineOf = (e: ThreadEvent): string => {
  const body = clip(
    neutralizePromptTags(redactText(JSON.stringify(e.payload ?? null))),
    e.kind === "question" ? QUESTION_LINE_CHARS : PAYLOAD_CHARS,
  );
  return `- ${e.kind} task=${e.itemId ?? e.taskId ?? "-"} ${body}`;
};

/** What one announce run reads: `shown` goes into the prompt, `coalesced` ids are closed with it, `more` waits for the next run. */
export interface NewsBatch {
  shown: ThreadEvent[];
  coalesced: string[];
  more: number;
}

/**
 * Cap one announce batch (oldest first): at most ANNOUNCE_MAX_EVENTS events and ANNOUNCE_MAX_CHARS of lines. A goal over
 * budget fails every ready item with its own `budget_hit`: only the first one of a goal is shown, the others are
 * `coalesced` (closed with the batch, no information lost). The rest is counted in `more` and stays undelivered.
 */
export function capNews(news: readonly ThreadEvent[]): NewsBatch {
  const shown: ThreadEvent[] = [];
  const coalesced: string[] = [];
  const budgetGoals = new Set<string>();
  let chars = 0;
  let more = 0;
  for (const e of news) {
    if (e.kind === "budget_hit") {
      const goal = e.taskId ?? e.itemId ?? e.id;
      if (budgetGoals.has(goal)) {
        coalesced.push(e.id);
        continue;
      }
      budgetGoals.add(goal);
    }
    const len = lineOf(e).length;
    // Once something is cut, later events wait too (order is kept); one event always fits.
    if (
      more ||
      (shown.length && (shown.length >= ANNOUNCE_MAX_EVENTS || chars + len > ANNOUNCE_MAX_CHARS))
    )
      more++;
    else {
      shown.push(e);
      chars += len;
    }
  }
  return { shown, coalesced, more };
}

/** The announce block `<events>`: one line per event, then how many more events wait. */
export function announceBlock(events: readonly ThreadEvent[], more = 0): string {
  const tail = more ? [`- +${more} more events wait; they come in the next announce`] : [];
  return [`<${EVENTS_TAG}>`, ...events.map(lineOf), ...tail, `</${EVENTS_TAG}>`].join("\n");
}

/**
 * The lead run ended: close what it consumed. The announced news, the owner messages it carried (`ownerEventIds`: never
 * the ones still debouncing or queued) and the lead's own records (not the `start` work orders: `dispatch-ready` closes
 * those when it starts the item).
 */
export function settleLeadEvents(
  db: Database,
  threadId: string,
  announced: readonly string[],
  ownerEventIds: readonly string[] = [],
): void {
  const records = listUndelivered(db, threadId)
    .filter((e) => byLead(e) && e.kind !== "start")
    .map((e) => e.id);
  markDeliveredIds(db, [...announced, ...ownerEventIds, ...records]);
}

/* Announce: worker news (result, failure, question, blocked) wakes the thread's lead. News that comes close together is
   batched: one timer per thread, and when it fires ONE announce input is queued (the run reads all the news then). */

/** Quiet window (ms) that batches the news of a thread into one lead run. */
const ANNOUNCE_WINDOW_MS = 2000;

/**
 * Delay (ms) before a dropped announce is armed again, after `streak` refusals in a row: the window doubled per refusal, up to
 * `ANNOUNCE_REARM_MAX_MS`. A full lead pool must not be polled every window by every thread that waits on it.
 */
export const announceRearmDelay = (streak: number, windowMs = ANNOUNCE_WINDOW_MS): number =>
  Math.min(windowMs * 2 ** Math.min(streak, 16), ANNOUNCE_REARM_MAX_MS);

/**
 * The announcer: `notify` after an event was appended (`delayMs` replaces the quiet window; a waiting batch is brought
 * forward by a smaller delay, never pushed back); `stopAll` at shutdown.
 */
export interface Announcer {
  notify(threadId: string, delayMs?: number): void;
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
  /** The waiting batch of a thread: its timer and the time it fires. */
  const timers = new Map<string, { t: ReturnType<typeof setTimeout>; at: number }>();
  return {
    notify(threadId, delayMs) {
      const delay = delayMs ?? o.windowMs ?? ANNOUNCE_WINDOW_MS;
      const at = Date.now() + delay;
      const waiting = timers.get(threadId);
      if (waiting && waiting.at <= at) return; // a batch is already waiting, and fires no later
      clearTimeout(waiting?.t); // an urgent news (a blocker) brings the batch forward
      const t = setTimeout(() => {
        timers.delete(threadId);
        if (wakesLead(o.db, threadId)) o.push({ threadId, kind: "announce", messageIds: [] });
      }, delay);
      t.unref(); // a batch never keeps the process alive
      timers.set(threadId, { t, at });
    },
    cancel(threadId) {
      clearTimeout(timers.get(threadId)?.t);
      timers.delete(threadId);
    },
    stopAll() {
      for (const w of timers.values()) clearTimeout(w.t);
      timers.clear();
    },
  };
}
