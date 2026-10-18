import { ZOMBIE_CLAIM_NOTICE_MS } from "../../config/resilience-caps";
import { logEvent, logger } from "../../observability/logger";
import { appendEvent } from "../../storage/thread-event-store";
import type { LeadRuntime } from "../lead/lead-runtime";
import { takeStuckClaims } from "../run/zombie-claims";

/** Logger of this module. */
const log = logger.child({ module: "zombie-notice" });

/**
 * A force-closed writer run that has still not returned after `maxMs`: its location stays claimed (no process is reachable
 * to kill, and releasing the claim would let a second writer in), so the lead is told once with a `timeout` event and the
 * log warns. Returns how many claims were reported.
 */
export function noticeStuckZombies(
  rt: LeadRuntime,
  now = Date.now(),
  maxMs = ZOMBIE_CLAIM_NOTICE_MS,
): number {
  let reported = 0;
  for (const c of takeStuckClaims(now, maxMs)) {
    logEvent(log, "zombie.claim_stuck", { location: c.location, itemId: c.itemId }, "warn");
    if (!c.threadId) continue; // no owner to tell (the log line is the notice)
    appendEvent(rt.deps.db, {
      id: `zombie:${c.itemId}:${c.since}`,
      threadId: c.threadId,
      ...(c.goalId && { taskId: c.goalId }),
      ...(c.itemId && { itemId: c.itemId }),
      kind: "timeout",
      payload: {
        cause: "zombie_claim",
        location: c.location,
        minutes: Math.round((now - c.since) / 60_000),
      },
    });
    rt.announce(c.threadId);
    reported++;
  }
  return reported;
}
