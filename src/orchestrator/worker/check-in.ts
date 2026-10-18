import {
  DIGEST_FLOOR_MS,
  HOLD_ESCALATE_MS,
  HOLD_REESCALATE_MS,
  ITEM_MAX_AGE_MS,
  MAX_ESCALATIONS_PER_TICK,
} from "../../config/resilience-caps";
import { renderDigest } from "../../ingress/digest-copy";
import { messageLanguage, pinnedThreadLanguage } from "../../ingress/user-copy";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { type DigestGoal, goalsWithLiveWork, heldTooLong } from "../../storage/check-in-store";
import { appendEvent } from "../../storage/thread-event-store";
import { type LeadRuntime, postTo } from "../lead/lead-runtime";
import { digestFacts, factsKey } from "./digest-facts";

/* The timer check-in, on the resilience tick: (1) a code-rendered digest (0 LLM tokens) per thread with an open goal that
   has running or held items, at most every `DIGEST_FLOOR_MS` and only when the facts changed; (2) one `timeout` event +
   announce for a held item nobody decided for `HOLD_ESCALATE_MS`, again every `HOLD_REESCALATE_MS`. Digest state is in memory: a restart costs at most one
   extra digest. Nothing here throws. */

/** Logger of this module. */
const log = logger.child({ module: "check-in" });

/** Escalate every held item that waited long enough (again after `HOLD_REESCALATE_MS` while it stays undecided). */
function escalateHolds(rt: LeadRuntime, now: number): void {
  for (const h of heldTooLong(
    rt.deps.db,
    now,
    HOLD_ESCALATE_MS,
    ITEM_MAX_AGE_MS * 3,
    MAX_ESCALATIONS_PER_TICK,
    HOLD_REESCALATE_MS,
  )) {
    // The query already spaced the escalations (floor); the id carries the moment so each one is its own event.
    const written = appendEvent(rt.deps.db, {
      id: `hold:${h.itemId}:${h.dispatchCount}:${now}`,
      createdAt: now, // the clock of the tick (the repeat floor compares against it)
      threadId: h.threadId,
      taskId: h.goalId,
      itemId: h.itemId,
      kind: "timeout",
      payload: {
        key: h.itemKey,
        status: "blocked",
        cause: "hold_undecided",
        heldMinutes: Math.round((now - h.heldAt) / 60_000),
      },
    });
    if (!written) continue; // the same tick twice
    logEvent(log, "hold.escalated", { itemId: h.itemId, threadId: h.threadId }, "warn");
    rt.announce(h.threadId);
  }
}

/** Build the check-in: the returned function is called once per tick (`now` is injectable for tests). */
export function createCheckIn(): (rt: LeadRuntime, now?: number) => Promise<void> {
  /** Per thread: when the last digest was tried and the hash of the facts it showed. */
  const state = new Map<string, { at: number; hash: string }>();
  /** Threads with a post in flight (a slow post must not start a second one). */
  const inflight = new Set<string>();

  /** Post one thread's digest (state is updated here; never throws). */
  async function digestOne(rt: LeadRuntime, g: DigestGoal, now: number): Promise<void> {
    const { threadId } = g;
    const prev = state.get(threadId);
    if (inflight.has(threadId) || (prev && now - prev.at < DIGEST_FLOOR_MS)) return;
    const facts = digestFacts(rt.deps.db, g.goalId, g.objective, now);
    const hash = factsKey(facts);
    if (prev?.hash === hash) return;
    const ctx = rt.ctxOf(threadId);
    if (!ctx) return; // no way to post into this thread yet
    const text = renderDigest(
      facts,
      pinnedThreadLanguage(threadId) ?? messageLanguage(ctx.message),
    );
    inflight.add(threadId);
    try {
      await postTo(ctx, text);
      state.set(threadId, { at: now, hash });
    } catch (err) {
      // Keep the old hash: the digest is tried again after the floor (the thread may be archived).
      state.set(threadId, { at: now, hash: prev?.hash ?? "" });
      logEvent(log, "digest.post_failed", { threadId, err: errText(err) }, "warn");
    } finally {
      inflight.delete(threadId);
    }
  }

  async function digests(rt: LeadRuntime, now: number): Promise<void> {
    // One goal per thread: the newest.
    const goals = new Map(goalsWithLiveWork(rt.deps.db).map((g) => [g.threadId, g]));
    for (const [t, s] of state) {
      if (goals.has(t)) continue;
      // No live work this tick: keep the floor time (work that resumes inside the floor must not digest at once),
      // forget the hash, and drop the entry only after a long idle.
      if (now - s.at > DIGEST_FLOOR_MS * 2) state.delete(t);
      else state.set(t, { at: s.at, hash: "" });
    }
    // allSettled: one hung post must not hold up the other threads.
    await Promise.allSettled([...goals.values()].map((g) => digestOne(rt, g, now)));
  }

  return async (rt, now = Date.now()) => {
    try {
      escalateHolds(rt, now);
      await digests(rt, now);
    } catch (err) {
      logEvent(log, "check_in.failed", { err: errText(err) }, "error");
    }
  };
}
