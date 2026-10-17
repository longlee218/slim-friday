import type { Database } from "bun:sqlite";
import { collectLimits } from "../../config/limits-report";
import { type LimitsView, type LiveState, renderLimits } from "../../ingress/limits-copy";
import { runningItemsByThread } from "../../storage/running-items-store";
import { deferredCount } from "../worker/slot-wait";
import type { RunLimiter } from "./run-limiter";

/** The live counters of `/limits`: slots used per pool, lead threads waiting, items waiting for a worker slot, items running per thread. */
export function liveState(db: Database, worker: RunLimiter, lead: RunLimiter): LiveState {
  return {
    leadUsed: lead.active(),
    leadWaiting: lead.waiting(),
    workerUsed: worker.active(),
    // The worker limiter never queues (items are deferred by the scheduler), so its own `waiting()` is always 0.
    readyWaiting: deferredCount(),
    running: runningItemsByThread(db),
  };
}

/** `/limits [role]`: collected limits (code values) + live state, worded for the owner. */
export function createLimitsView(db: Database, worker: RunLimiter, lead: RunLimiter): LimitsView {
  return async (role, language) =>
    renderLimits(await collectLimits(), { role, live: liveState(db, worker, lead), language });
}
