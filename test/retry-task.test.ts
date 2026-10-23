import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { GOAL_BUDGET_USD } from "../src/orchestrator/budget/task-budget";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { handleCancel, handleDispatch } from "../src/orchestrator/teammate/teammate-handlers";
import { handleRetry } from "../src/orchestrator/teammate/teammate-retry-handler";
import { openDb } from "../src/storage/db";
import { getItem, setResultKind } from "../src/storage/owned-item-store";
import { getOwnedTask, linkTurn } from "../src/storage/owned-task-store";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTurn } from "../src/storage/run-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { moveTaskTo } from "../src/tasks/task-resolver";

/* Orchestrate retry and Orchestrate cancel on a held item (blocked + FAILED), over the real db port. */

const TH = "th1";
let db: Database;
afterEach(() => db?.close());

/** A port + a goal with `a` (developer) and `b` (scout, waits for a); `a` is held after a failed run with turn `tn`. */
async function held() {
  db = openDb(":memory:");
  const port = createDbEffectPort({
    db,
    threadId: TH,
    env: { workerRoles: ["developer", "scout"], locations: ["repo"] },
    io: {
      steerTask: () => "queued",
      askOwner: async () => ({ answer: "a", timedOut: false }),
      post: async () => {},
    },
  });
  const ctx = (n: string) => ({
    port,
    threadId: TH,
    teammateTurnId: `lt-${n}`,
    inputId: n,
    run: { dispatched: 0 },
  });
  const d = (await handleDispatch(ctx("d"), {
    strategy: "DELEGATE",
    small: true,
    intent: "two steps",
    reason: "r",
    assignments: [
      { key: "a", subject: "task", role: "developer", brief: "first", dependsOn: [] },
      { key: "b", subject: "task", role: "scout", brief: "second", dependsOn: ["a"] },
    ],
  })) as unknown as { goalId: string; itemIds: string[] };
  const [a, b] = d.itemIds as [string, string];
  insertTurn(db, { id: "tn", threadId: TH, source: "t", location: "r", role: "developer" });
  linkTurn(db, "tn", a);
  db.query("UPDATE owned_tasks SET dispatch_count = 1, attempt = 2 WHERE id = ?").run(a);
  moveTaskTo(db, a, "running");
  moveTaskTo(db, a, "blocked");
  setResultKind(db, a, "FAILED");
  return { ctx, goalId: d.goalId, a, b };
}

test("Orchestrate retry: held -> ready, fresh resume budget, a retry event names the turn and carries the note", async () => {
  const { ctx, a } = await held();
  const r = await handleRetry(ctx("r1"), { taskId: a, note: "use the other branch" });
  expect(r).toMatchObject({ ok: true, retried: a });
  expect(getItem(db, a)).toMatchObject({ status: "ready", attempt: 0 });
  const ev = listUndelivered(db, TH).find((e) => e.kind === "retry");
  expect(ev?.payload).toMatchObject({
    note: "use the other branch",
    afterTurn: "tn",
    by: "teammate",
  });
  // A replay of the same call is one effect.
  expect(await handleRetry(ctx("r1"), { taskId: a, note: "use the other branch" })).toEqual(r);
});

test("Orchestrate retry refusals: NOT_HELD (not blocked), ENDED, BREAKER at 3 dispatches, BAD_TASK", async () => {
  const { ctx, a, b } = await held();
  expect(await handleRetry(ctx("n1"), { taskId: b, note: "x" })).toMatchObject({
    ok: false,
    code: "NOT_HELD",
  });
  db.query("UPDATE owned_tasks SET result_kind = 'FAILED', dispatch_count = 3 WHERE id = ?").run(a);
  expect(await handleRetry(ctx("n3"), { taskId: a, note: "x" })).toMatchObject({ code: "BREAKER" });
  expect(getItem(db, a)?.status).toBe("blocked");
  expect(await handleRetry(ctx("n4"), { taskId: "nope", note: "x" })).toMatchObject({
    code: "BAD_TASK",
  });
  moveTaskTo(db, a, "failed");
  expect(await handleRetry(ctx("n5"), { taskId: a, note: "x" })).toMatchObject({ code: "ENDED" });
});

test("Orchestrate cancel on a held item: it fails, dependents are cancelled, the goal settles failed", async () => {
  const { ctx, goalId, a, b } = await held();
  const r = (await handleCancel(ctx("c1"), { taskId: a, reason: "give up" })) as unknown as {
    cancelled: string[];
  };
  expect(r.cancelled.sort()).toEqual([a, b].sort());
  expect(getItem(db, a)?.status).toBe("failed");
  expect(getItem(db, b)?.status).toBe("cancelled");
  expect(getOwnedTask(db, goalId)?.status).toBe("failed");
});

test("Orchestrate retry clears the held marker: after the move the item is ready with no result kind (isHeld cannot read a stale FAILED)", async () => {
  const { ctx, a } = await held();
  await handleRetry(ctx("k1"), { taskId: a, note: "again" });
  expect(getItem(db, a)).toMatchObject({ status: "ready", resultKind: null });
});

test("Orchestrate retry refuses with OVER_BUDGET when the goal already used its budget, and changes nothing", async () => {
  const { ctx, a } = await held();
  // The goal's runs cost more than the goal budget.
  insertRun(db, {
    id: "r1",
    turnId: "tn",
    model: "m",
    outcome: "success",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: GOAL_BUDGET_USD + 1,
    turns: 1,
    durationMs: 1,
    compactions: 0,
  });
  const r = await handleRetry(ctx("k2"), { taskId: a, note: "again" });
  expect(r).toMatchObject({ ok: false, code: "OVER_BUDGET" });
  expect(getItem(db, a)).toMatchObject({ status: "blocked", resultKind: "FAILED" });
});

test("Orchestrate retry accepts a plain blocked item (BLOCKED / NEEDS_PLANNING report): blocked is held too", async () => {
  const { ctx, a } = await held();
  db.query("UPDATE owned_tasks SET result_kind = 'BLOCKED' WHERE id = ?").run(a);
  expect(await handleRetry(ctx("n2"), { taskId: a, note: "unblocked now" })).toMatchObject({
    ok: true,
    retried: a,
  });
  expect(getItem(db, a)).toMatchObject({ status: "ready", resultKind: null });
});
