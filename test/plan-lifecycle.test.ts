import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { PLAN_MAX_REVISIONS } from "../src/config/lead-caps";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { openGoalIdOf } from "../src/orchestrator/goal/effect-port-queries";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { type Edit, revisePlan } from "../src/orchestrator/plan/plan-revision";
import { settleGoal } from "../src/orchestrator/worker/goal-settle";
import { openDb } from "../src/storage/db";
import { childrenOf } from "../src/storage/owned-item-store";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { getPlan, planVersions } from "../src/storage/work-plan-store";
import { moveTaskTo } from "../src/tasks/task-resolver";

/* Plan lifecycle over a real in-memory db: create, approve (items), revise (CAS, envelope), reject, history. */

let db: Database;
afterEach(() => db?.close());
const ENV = { workerRoles: ["developer", "scout"], locations: ["repo", "docs"], goalBudgetUsd: 6 };
const item = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  role: "developer",
  brief: `do ${key}`,
  dependsOn: [] as string[],
  risk: "R1",
  ...over,
});
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};

/** A goal with its planner item, and a plan of the given items (valid). */
function setup(items = [item("a"), item("b", { dependsOn: ["a"] })]) {
  db = openDb(":memory:");
  const w = createPlanPort(db, "th1").requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items,
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    budgetUsd: 3,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  return { goalId: w.goalId, plan: r.plan };
}
const edit = (over: Partial<Edit> = {}): Edit => ({ add: [], cancel: [], modify: [], ...over });
const keys = (goalId: string) => childrenOf(db, goalId).map((i) => `${i.itemKey}:${i.status}`);

test("create stores version 1 valid; a second plan for the goal is refused", () => {
  const { goalId, plan } = setup();
  expect([plan.version, plan.status]).toEqual([1, "valid"]);
  const again = createPlan(db, {
    goalId,
    objective: "x",
    items: [item("z")],
    acceptanceCriteria: [],
    envelope: ENVELOPE,
    budgetUsd: 1,
    effects: [],
    env: ENV,
  });
  expect(again).toMatchObject({ ok: false, code: "PLAN_EXISTS" });
});

test("a plan that fails validation is not stored", () => {
  db = openDb(":memory:");
  const w = createPlanPort(db, "th1").requestPlan({ key: "k1", objective: "o" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "o",
    items: [item("a", { role: "lead" })],
    acceptanceCriteria: [],
    envelope: ENVELOPE,
    budgetUsd: 1,
    effects: [],
    env: ENV,
  });
  expect(r).toMatchObject({ ok: false, code: "INVALID" });
  expect(db.query("SELECT COUNT(*) AS n FROM work_plans").get()).toEqual({ n: 0 });
});

test("a valid plan keeps the goal open after the planner ended; approve creates items in dependency order, once", () => {
  const { goalId, plan } = setup();
  const planner = childrenOf(db, goalId)[0]!;
  moveTaskTo(db, planner.id, "running");
  moveTaskTo(db, planner.id, "completed");
  settleGoal(db, goalId);
  expect(getOwnedTask(db, goalId)?.status).toBe("open"); // the plan waits for the owner
  expect(openGoalIdOf(db, "th1")).toBe(goalId);
  const done = approveVersion(db, plan.id, 1);
  expect(done).toMatchObject({ ok: true, created: ["a", "b"] });
  expect(keys(goalId)).toEqual(["planner:completed", "a:ready", "b:pending", "verify-1:pending"]);
  expect(getPlan(db, plan.id, 1)?.status).toBe("approved");
  expect(getPlan(db, plan.id, 1)?.approvedAt).not.toBeNull();
  // The same version cannot be approved twice: nothing is created again.
  expect(approveVersion(db, plan.id, 1)).toMatchObject({ ok: false, code: "PLAN_NOT_VALID" });
  expect(childrenOf(db, goalId)).toHaveLength(4);
  expect(db.query("SELECT COUNT(*) AS n FROM thread_events WHERE kind = 'start'").get()).toEqual({
    n: 4,
  }); // planner + 2
});

test("reject: no approved version -> the goal and its items are cancelled; history is kept", () => {
  const { goalId, plan } = setup();
  expect(rejectVersion(db, plan.id, 1, "owner rejected")).toEqual({ ok: true });
  expect(getPlan(db, plan.id, 1)).toMatchObject({ status: "rejected", reason: "owner rejected" });
  expect(getOwnedTask(db, goalId)?.status).toBe("cancelled");
  expect(openGoalIdOf(db, "th1")).toBeUndefined();
});

test("revision of a valid version: new version valid, old superseded, stale base refused", () => {
  const { plan } = setup();
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ add: [item("c")] }),
    reason: "more",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, version: 2, status: "valid" });
  expect(planVersions(db, plan.id).map((v) => v.status)).toEqual(["superseded", "valid"]);
  const stale = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit(),
    reason: "x",
    env: ENV,
  });
  expect(stale).toMatchObject({ ok: false, code: "STALE_VERSION" });
});

test("revision of an approved plan within the envelope applies at once: add, cancel, modify; no new question", () => {
  const { goalId, plan } = setup([item("a"), item("b", { dependsOn: ["a"] }), item("c")]);
  approveVersion(db, plan.id, 1);
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({
      add: [item("d", { dependsOn: ["a"] })],
      cancel: ["c"],
      modify: [{ key: "b", brief: "do b better" }],
    }),
    reason: "scope",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, version: 2, status: "approved" });
  expect(r.ok && r.affected).toEqual({ created: ["d"], modified: ["b"], cancelled: ["c"] });
  expect(keys(goalId)).toEqual([
    "planner:ready",
    "a:ready",
    "c:cancelled",
    "b:pending",
    "verify-1:pending",
    "d:pending",
  ]);
  expect(childrenOf(db, goalId).find((i) => i.itemKey === "b")?.brief).toBe("do b better");
  expect(planVersions(db, plan.id).map((v) => v.status)).toEqual(["superseded", "approved"]);
});

test("a started item cannot be modified; unknown keys and the revision cap are refused", () => {
  const { goalId, plan } = setup();
  approveVersion(db, plan.id, 1);
  const a = childrenOf(db, goalId).find((i) => i.itemKey === "a")!;
  moveTaskTo(db, a.id, "running");
  expect(
    revisePlan(db, {
      planId: plan.id,
      baseVersion: 1,
      edit: edit({ modify: [{ key: "a", brief: "x" }] }),
      reason: "r",
      env: ENV,
    }),
  ).toMatchObject({ ok: false, code: "ITEM_STARTED" });
  expect(
    revisePlan(db, {
      planId: plan.id,
      baseVersion: 1,
      edit: edit({ cancel: ["zzz"] }),
      reason: "r",
      env: ENV,
    }),
  ).toMatchObject({ ok: false, code: "UNKNOWN_KEY" });
  for (let v = 1; v <= PLAN_MAX_REVISIONS; v++) {
    const r = revisePlan(db, {
      planId: plan.id,
      baseVersion: v,
      edit: edit({ add: [item(`x${v}`)] }),
      reason: "r",
      env: ENV,
    });
    expect(r).toMatchObject({ ok: true, version: v + 1 });
  }
  const over = revisePlan(db, {
    planId: plan.id,
    baseVersion: PLAN_MAX_REVISIONS + 1,
    edit: edit({ add: [item("x9")] }),
    reason: "r",
    env: ENV,
  });
  expect(over).toMatchObject({ ok: false, code: "INVALID" });
  expect(over.ok === false && over.errors?.map((e) => e.code)).toContain("TOO_MANY_REVISIONS");
});

test("envelope grows -> new version waits as valid, the approved one stays in force; approving it applies the diff", () => {
  const { goalId, plan } = setup();
  approveVersion(db, plan.id, 1);
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({
      add: [item("d", { location: "docs" })],
      envelope: { ...ENVELOPE, locations: ["repo", "docs"] },
    }),
    reason: "docs too",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, version: 2, status: "valid" });
  expect(planVersions(db, plan.id).map((v) => v.status)).toEqual(["approved", "valid"]);
  expect(keys(goalId)).toEqual(["planner:ready", "a:ready", "b:pending", "verify-1:pending"]); // nothing applied yet
  expect(approveVersion(db, plan.id, 2)).toMatchObject({ ok: true, created: ["d"] });
  expect(planVersions(db, plan.id).map((v) => v.status)).toEqual(["superseded", "approved"]);
  expect(childrenOf(db, goalId).find((i) => i.itemKey === "d")?.location).toBe("docs");
});

test("NEEDS_PLANNING items are released (cancelled) by the first approval; finished items stay and can be depended on", () => {
  db = openDb(":memory:");
  const port = createPlanPort(db, "th1");
  const w = port.requestPlan({ key: "k1", objective: "big" });
  if (!w.ok) throw new Error("no goal");
  // An earlier worker item of the goal: one completed, one blocked asking for a plan.
  const { insertOwnedTask } = require("../src/storage/owned-task-store");
  for (const [key, st] of [
    ["done1", "completed"],
    ["stuck", "blocked"],
  ] as const)
    insertOwnedTask(db, {
      id: `i-${key}`,
      threadId: "th1",
      ownerRole: "developer",
      status: "ready",
      scope: key,
      correlationId: "c",
      parentId: w.goalId,
      itemKey: key,
    });
  moveTaskTo(db, "i-done1", "running");
  moveTaskTo(db, "i-done1", "completed");
  moveTaskTo(db, "i-stuck", "running");
  moveTaskTo(db, "i-stuck", "blocked");
  db.query("UPDATE owned_tasks SET result_kind = 'NEEDS_PLANNING' WHERE id = 'i-stuck'").run();
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "big",
    items: [item("next", { dependsOn: ["done1"] })],
    acceptanceCriteria: [],
    envelope: ENVELOPE,
    budgetUsd: 2,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  approveVersion(db, r.plan.id, 1);
  expect(keys(w.goalId)).toEqual([
    "planner:ready",
    "done1:completed",
    "stuck:cancelled",
    "next:pending",
  ]);
});

test("RequestPlan inside the open goal adds a second planner item (planner-2) and keeps the finished items", () => {
  const { goalId } = setup();
  const port = createPlanPort(db, "th1");
  const w = port.requestPlan({ key: "k2", objective: "re-plan", goalId });
  expect(w).toMatchObject({ ok: true, goalId });
  expect(keys(goalId)).toEqual(["planner:ready", "planner-2:ready"]);
  expect(port.requestPlan({ key: "k3", objective: "x", goalId: "foreign" })).toMatchObject({
    ok: false,
    code: "BAD_TASK",
  });
  // One audit row per request (k1, k2).
  expect(db.query("SELECT COUNT(*) AS n FROM effect_log").get()).toEqual({ n: 2 });
});
