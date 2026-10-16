import { logEvent, logger } from "../../observability/logger";
import { childrenOf, type ItemRow } from "../../storage/owned-item-store";
import { appendEvent, markStartDelivered } from "../../storage/thread-event-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { GOAL_BUDGET_USD, goalOverBudget } from "../budget/task-budget";
import { openGoalIdOf } from "../goal/effect-port-queries";
import type { LeadRuntime } from "../lead/lead-runtime";
import { cancelDependents, settleGoal } from "./goal-settle";
import { startWorker } from "./worker-run";

/** Logger of this module. */
const log = logger.child({ module: "dispatch-ready" });

/** Circuit breaker: an item dispatched this many times fails instead of starting again. */
const MAX_DISPATCHES_PER_ITEM = 3;

/** Wait (ms) before a pass retries an item the run cap deferred (any worker ending retries earlier). */
const BUSY_RETRY_MS = 3000;

/** Threads whose ready item the run cap deferred, with their retry timer. */
const deferred = new Map<string, ReturnType<typeof setTimeout>>();

/** Threads with a pass in progress, and the ones asked again meanwhile (one pass per thread at a time). */
const passing = new Set<string>();
const again = new Set<string>();

/** Fail an item the engine will not start (breaker, budget): the work order closes, dependents are cancelled, the lead is told. */
function failItem(
  rt: LeadRuntime,
  threadId: string,
  it: ItemRow,
  kind: "failure" | "budget_hit",
  reason: string,
): void {
  const { db } = rt.deps;
  moveTaskTo(db, it.id, "failed");
  markStartDelivered(db, it.id);
  cancelDependents(db, it.id);
  appendEvent(db, {
    id: `${kind}:${it.id}:${it.dispatchCount}`,
    threadId,
    taskId: it.parentId ?? it.id,
    itemId: it.id,
    kind,
    payload: { key: it.itemKey, error: reason },
  });
  logEvent(log, "dispatch.refused", { itemId: it.id, kind, reason }, "warn");
}

/** Retry the thread's pass once after `BUSY_RETRY_MS` (one timer per thread; it never keeps the process alive). */
function deferRetry(rt: LeadRuntime, threadId: string): void {
  if (deferred.has(threadId)) return;
  const t = setTimeout(() => {
    deferred.delete(threadId);
    void dispatchReady(rt, threadId);
  }, BUSY_RETRY_MS);
  t.unref();
  deferred.set(threadId, t);
}

/** A worker ended and freed a run slot: every thread that was deferred retries now. */
function wakeDeferred(rt: LeadRuntime): void {
  for (const [threadId, t] of [...deferred]) {
    clearTimeout(t);
    deferred.delete(threadId);
    void dispatchReady(rt, threadId);
  }
}

/** One pass: promote waiting items, start the next ready one (never two at once), settle the goal when all ended. */
async function pass(rt: LeadRuntime, threadId: string): Promise<void> {
  const { db } = rt.deps;
  const ctx = rt.ctxOf(threadId);
  const goalId = openGoalIdOf(db, threadId);
  if (!ctx || !goalId) return;
  for (;;) {
    let items = childrenOf(db, goalId);
    if (items.some((i) => i.status === "running")) return; // sequential: the running item's end calls us again
    // A pending item whose dependencies all completed is ready.
    for (const it of items)
      if (
        it.status === "pending" &&
        it.dependsOn.every((k) => items.find((x) => x.itemKey === k)?.status === "completed")
      )
        moveTaskTo(db, it.id, "ready");
    items = childrenOf(db, goalId);
    const next = items.find((i) => i.status === "ready");
    if (!next) {
      settleGoal(db, goalId);
      return;
    }
    if (next.dispatchCount >= MAX_DISPATCHES_PER_ITEM) {
      failItem(rt, threadId, next, "failure", `dispatched ${next.dispatchCount} times`);
    } else if (goalOverBudget(db, items)) {
      failItem(rt, threadId, next, "budget_hit", `goal budget $${GOAL_BUDGET_USD} used`);
    } else {
      const started = await startWorker(rt, ctx, threadId, next, () => {
        rt.announce(threadId);
        void dispatchReady(rt, threadId);
        wakeDeferred(rt);
      });
      if (!started) {
        // Run cap reached: the item stays ready and is retried on the next worker end or after a short wait.
        logEvent(log, "dispatch.deferred", { itemId: next.id, reason: "run_limit" }, "warn");
        deferRetry(rt, threadId);
      }
      return; // started: it is running now; deferred: it waits
    }
    rt.announce(threadId); // a failed item is news
  }
}

/**
 * Start the work the lead queued: the next ready item of the thread's open goal, in dependency order, one at a time.
 * Called after a lead run and after each worker ends. Calls that overlap on one thread run one pass after another.
 */
export async function dispatchReady(rt: LeadRuntime, threadId: string): Promise<void> {
  if (passing.has(threadId)) {
    again.add(threadId);
    return;
  }
  passing.add(threadId);
  try {
    do {
      again.delete(threadId);
      await pass(rt, threadId).catch((err: unknown) =>
        logEvent(log, "dispatch.pass_failed", { threadId, err: String(err) }, "error"),
      );
    } while (again.has(threadId));
  } finally {
    passing.delete(threadId);
  }
}
