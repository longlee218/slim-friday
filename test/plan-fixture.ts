import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { PLAN_MAX_ITEMS } from "../src/config/lead-caps";
import { PLAN_GOAL_BUDGET_MAX_USD } from "../src/config/model-routing";
import { approveVersion, createPlan } from "../src/orchestrator/plan/plan-lifecycle";
import { openDb } from "../src/storage/db";
import { childrenOf, setResultKind, setTaskResult } from "../src/storage/owned-item-store";
import { insertOwnedTask, linkTurn } from "../src/storage/owned-task-store";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTurn } from "../src/storage/run-store";
import { moveTaskTo } from "../src/tasks/task-resolver";

/* Shared setup of the plan, verify and goal-budget tests: a real db, an approved plan, item helpers. */

export const TH = "t";
/** Validator facts: the roles and locations the plans use. */
export const ENV = {
  workerRoles: ["developer", "scout"],
  locations: ["repo", "docs"],
};
export const item = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  subject: `Do ${key}`,
  role: "developer",
  brief: `do ${key}`,
  location: "repo",
  dependsOn: [] as string[],
  risk: "R1",
  ...over,
});

/** An open PLAN goal (no item yet) in `db`: what `create_plan` makes before the plan is approved. */
export function openPlanGoal(
  db: Database,
  threadId: string,
  objective = "build it",
): { ok: true; goalId: string } {
  const goalId = crypto.randomUUID();
  insertOwnedTask(db, {
    id: goalId,
    threadId,
    ownerRole: "lead",
    status: "open",
    scope: objective,
    correlationId: goalId,
    structureOwner: "plan",
  });
  return { ok: true, goalId };
}

/** A fresh db with one open PLAN goal (no item yet); returns the goal id. */
export function newGoal(): { db: Database; goalId: string } {
  const db = openDb(":memory:");
  return { db, goalId: openPlanGoal(db, TH).goalId };
}

/**
 * Pin the stored budget of a plan version (column and envelope). Code computes a plan's budget from its items' role
 * ceilings; the budget-hit tests need a small round figure instead, as if the plan had been stored with it.
 */
export function setStoredBudget(
  db: Database,
  planId: string,
  version: number,
  budgetUsd: number,
): void {
  db.query(
    "UPDATE work_plans SET budget_usd = ?, envelope = json_set(envelope, '$.budgetUsd', ?) WHERE id = ? AND version = ?",
  ).run(budgetUsd, budgetUsd, planId, version);
}

/**
 * An approved plan v1 (items, criteria, budget, locations) on a fresh goal. `budget` pins the stored budget; the default is
 * the goal ceiling, so a revision that adds scope cannot raise it (the verify mechanics under test); `null` keeps the budget code computed.
 */
export function approvedPlan(
  items: ReturnType<typeof item>[],
  o: { criteria?: string[]; budget?: number | null; locations?: string[] } = {},
) {
  const { db, goalId } = newGoal();
  const r = createPlan(db, {
    goalId,
    objective: "build it",
    items,
    acceptanceCriteria: o.criteria ?? ["tests pass"],
    envelope: {
      locations: o.locations ?? ["repo"],
      riskClasses: ["R0", "R1"],
      bounds: { maxItems: PLAN_MAX_ITEMS, maxGb: 1 },
    },
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  const budget = o.budget === undefined ? PLAN_GOAL_BUDGET_MAX_USD : o.budget;
  if (budget !== null) setStoredBudget(db, r.plan.id, 1, budget);
  expect(approveVersion(db, r.plan.id, 1).ok).toBe(true);
  return { db, goalId, planId: r.plan.id };
}

export const keysOf = (db: Database, g: string) =>
  childrenOf(db, g).map((i) => `${i.itemKey}:${i.status}`);
export const byKey = (db: Database, g: string, k: string) =>
  childrenOf(db, g).find((i) => i.itemKey === k)!;
/** An item ran to the end. */
export const complete = (db: Database, g: string, k: string) => {
  const id = byKey(db, g, k).id;
  moveTaskTo(db, id, "ready");
  moveTaskTo(db, id, "running");
  moveTaskTo(db, id, "completed");
};
/** A verify run that reported FAILED: held (blocked + FAILED), with its excerpt. */
export const failVerify = (db: Database, g: string, k: string, excerpt = "npm test: 2 failed") => {
  const id = byKey(db, g, k).id;
  moveTaskTo(db, id, "ready");
  moveTaskTo(db, id, "running");
  moveTaskTo(db, id, "blocked");
  setResultKind(db, id, "FAILED");
  setTaskResult(db, id, { path: "/r.md", excerpt });
  return id;
};
/** Book `costUsd` as the cost of one run of the item (the goal's spend). */
export function spend(db: Database, itemId: string, costUsd: number, n = 1): void {
  insertTurn(db, { id: `tn${n}`, threadId: TH, source: "t", location: "r", role: "developer" });
  linkTurn(db, `tn${n}`, itemId);
  insertRun(db, {
    id: `run${n}`,
    turnId: `tn${n}`,
    model: "m",
    outcome: "success",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    turns: 1,
    durationMs: 1,
    compactions: 0,
  });
}
