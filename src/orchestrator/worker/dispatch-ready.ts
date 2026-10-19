import { MAX_DISPATCHES_PER_ITEM } from "../../config/resilience-caps";
import { WORKER_SLOT_RETRY_MS } from "../../config/run-caps";
import { logEvent, logger } from "../../observability/logger";
import { findRole } from "../../roles/role-registry";
import { childrenOf, type ItemRow, setResultKind } from "../../storage/owned-item-store";
import { appendEvent, holdCount, markStartDelivered } from "../../storage/thread-event-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { budgetReason, goalBudgetCanGrow, goalOverBudget } from "../budget/task-budget";
import { openGoalIdOf } from "../goal/effect-port-queries";
import type { LeadRuntime } from "../lead/lead-runtime";
import { startNextWave, waveGoalOf } from "../plan/plan-waves";
import { zombieClaims } from "../run/zombie-claims";
import { cancelDeadWaiters, cancelDependents, settleGoal } from "./goal-settle";
import { clearHold, waitMs } from "./resume-backoff";
import { hasPendingAnswer } from "./resume-prompt";
import { pickDispatchable, type RoleCaps } from "./scheduler";
import { clearSlotWait, noteDeferred } from "./slot-wait";
import { startWorker } from "./worker-run";

/** Logger of this module. */
const log = logger.child({ module: "dispatch-ready" });

/** Threads whose ready item the run cap deferred, with their retry timer. */
const deferred = new Map<string, ReturnType<typeof setTimeout>>();

/** Threads with a pass in progress, and the ones asked again meanwhile (one pass per thread at a time). */
const passing = new Set<string>();
const again = new Set<string>();

/**
 * Stop an item the engine will not start. The breaker (`failure`) fails it for good: the work order closes, dependents are
 * cancelled. A budget hit (`budget_hit`) only HOLDS it (`blocked`, FAILED): dependents wait and the lead retries it once the
 * budget allows, or cancels it. The lead is told either way.
 */
function failItem(
  rt: LeadRuntime,
  threadId: string,
  it: ItemRow,
  kind: "failure" | "budget_hit",
  reason: string,
): void {
  const { db } = rt.deps;
  const hold = kind === "budget_hit";
  const seq = holdCount(db, it.id); // before the event: a second hold of the item is its own event
  moveTaskTo(db, it.id, hold ? "blocked" : "failed");
  if (hold) setResultKind(db, it.id, "FAILED");
  markStartDelivered(db, it.id);
  if (!hold) cancelDependents(db, it.id);
  appendEvent(db, {
    id: `${kind}:${it.id}:${it.dispatchCount}:${seq}`,
    threadId,
    taskId: it.parentId ?? it.id,
    itemId: it.id,
    kind,
    payload: {
      key: it.itemKey,
      error: reason,
      // A budget hold tells the lead whether the budget can still rise (a retry is pointless when it cannot).
      ...(hold && { cause: "budget", canGrow: goalBudgetCanGrow(db, it.parentId ?? it.id) }),
    },
  });
  logEvent(log, "dispatch.refused", { itemId: it.id, kind, reason }, "warn");
}

/** Retry the thread's pass once after `ms` (default `WORKER_SLOT_RETRY_MS`; one timer per thread; it never keeps the process alive). */
function deferRetry(rt: LeadRuntime, threadId: string, ms = WORKER_SLOT_RETRY_MS): void {
  if (deferred.has(threadId)) return;
  const t = setTimeout(() => {
    deferred.delete(threadId);
    void dispatchReady(rt, threadId);
  }, ms);
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

/** Scheduler view of a role: whether it changes files (data of the role). */
const roleCaps = (name: string | null): RoleCaps => {
  const role = name ? findRole(name) : undefined;
  return { writer: role?.sideEffects === "location" };
};

/**
 * One pass: promote waiting items, fail the ones the engine will not start (breaker, budget), start the items the scheduler
 * picks (independent items run in parallel), settle the goal when all ended.
 */
async function pass(rt: LeadRuntime, threadId: string): Promise<void> {
  const { db } = rt.deps;
  const ctx = rt.ctxOf(threadId);
  // A goal whose last wave ended with deferred scope has no live item (so it is not "open"): the next wave starts it again.
  const goalId = openGoalIdOf(db, threadId) ?? waveGoalOf(db, threadId);
  if (!ctx || !goalId) return;
  if (rt.deps.stopping()) return; // shutdown: an item resumed by the abort starts at the next boot, not now
  for (;;) {
    // A pending item whose dependency ended without a result can never start: cancel it (the lead is told).
    if (cancelDeadWaiters(db, goalId).length) rt.announce(threadId);
    let items = childrenOf(db, goalId);
    // A pending item whose dependencies all completed is ready.
    for (const it of items)
      if (
        it.status === "pending" &&
        it.dependsOn.every((k) => items.find((x) => x.itemKey === k)?.status === "completed")
      )
        moveTaskTo(db, it.id, "ready");
    items = childrenOf(db, goalId);
    for (const it of items)
      if (it.status !== "ready") {
        clearHold(it.id); // a cancelled / ended item keeps no backoff entry
        clearSlotWait(it.id);
      }
    const ready = items.filter((i) => i.status === "ready");
    // Refused items first (a failed one cancels its dependents, so the list is read again).
    const overBudget = goalOverBudget(db, goalId);
    // The breaker stops a re-dispatch loop, never an automatic resume (`attempt > 0`): a transient failure at the third
    // dispatch still gets its capped resumes and then a hold for the lead, not a terminal failure.
    // An item resuming on an answer to its own question is no loop either (its start is not counted).
    const tripped = (i: ItemRow) =>
      i.attempt === 0 && i.dispatchCount >= MAX_DISPATCHES_PER_ITEM && !hasPendingAnswer(db, i.id);
    const refused = ready.find((i) => tripped(i) || overBudget);
    if (refused) {
      if (tripped(refused))
        failItem(rt, threadId, refused, "failure", `dispatched ${refused.dispatchCount} times`);
      else failItem(rt, threadId, refused, "budget_hit", budgetReason(db, goalId));
      rt.announce(threadId); // a failed item is news
      continue;
    }
    if (!ready.length) {
      // Rolling waves: the wave is done and scope is deferred: code inserts the next planner, which is then ready.
      if (startNextWave(db, goalId)) continue;
      settleGoal(db, goalId);
      return;
    }
    // A writer waits while a force-closed run of its location may still be alive (claim until the run returns); the
    // scheduler skips it, so it takes no slot from the items that can start.
    const zombie = (i: ItemRow) => zombieClaims(i.location);
    const picks = pickDispatchable(items, roleCaps, undefined, zombie);
    if (ready.some((i) => roleCaps(i.ownerRole).writer && zombie(i))) deferRetry(rt, threadId);
    for (const [at, next] of picks.entries()) {
      // An item waiting out its resume backoff keeps its place (and its location) and is tried again when due.
      const wait = waitMs(next.id);
      if (wait > 0) {
        deferRetry(rt, threadId, wait);
        continue;
      }
      // A start that throws (bad role data, db error) fails that item only: the other picks still start.
      const started = await startWorker(rt, ctx, threadId, next, (announce = true, delayMs) => {
        if (announce) rt.announce(threadId, delayMs);
        void dispatchReady(rt, threadId);
        wakeDeferred(rt);
      }).catch((err: unknown) => {
        failItem(rt, threadId, next, "failure", `start failed: ${String(err)}`);
        return true;
      });
      if (started) clearSlotWait(next.id);
      else {
        // Worker pool full: the item stays ready and is retried on the next worker end or after a short wait; the lead hears of it after 60 s.
        logEvent(log, "dispatch.deferred", { itemId: next.id, reason: "run_limit" }, "warn");
        // Every pick the pool keeps waiting (not only the head) starts its 60 s clock; an item in resume backoff is not a slot wait.
        for (const waiting of picks.slice(at))
          if (waitMs(waiting.id) <= 0) noteDeferred(rt, threadId, waiting);
        deferRetry(rt, threadId);
        break;
      }
    }
    return; // started items run now; the others wait for a worker end
  }
}

/**
 * Start the work the lead queued: the ready items of the thread's open goal that the caps allow (see scheduler.ts), in order.
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
