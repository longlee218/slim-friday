import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { openGoalIdOf } from "../src/orchestrator/goal/effect-port-queries";
import { handleApprovePlan } from "../src/orchestrator/lead/lead-plan-handlers";
import { buildEnvelope, toPlanItem } from "../src/orchestrator/plan/plan-doc";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { type Edit, revisePlan } from "../src/orchestrator/plan/plan-revision";
import { validatePlan } from "../src/orchestrator/plan/validate-plan";
import { checkDispatch } from "../src/orchestrator/strategy/dispatch-policy";
import { cancelDependents, settleGoal } from "../src/orchestrator/worker/goal-settle";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { dispatchableWorkers, ROLES } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { childrenOf } from "../src/storage/owned-item-store";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { getPlan, planVersions } from "../src/storage/work-plan-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { toolOptions, toolsFor } from "../src/tools/tool-catalog";
import { FakePort } from "./lead-fake-port";

/* Gap audit of phase L2b over a real in-memory db: superseded and stale approvals, a materialize that fails midway
   (rolls back all), a planner that crashes after or before storing a plan, a revision that drops a depended-on item,
   the planner's tool set and its non-dispatchability against the real registry. Only the model is faked. */

let db: Database;
afterEach(() => db?.close());
const ENV = {
  workerRoles: dispatchableWorkers().map((r) => r.name),
  locations: ["repo"],
};
const item = (key: string, over: Record<string, unknown> = {}) =>
  toPlanItem({ key, role: "developer", brief: `do ${key}`, dependsOn: [], risk: "R1", ...over });
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};
const edit = (over: Partial<Edit> = {}): Edit => ({ add: [], cancel: [], modify: [], ...over });
/** The planner run ended (completed): only the plan items decide whether the goal settles. */
const finishPlanner = (goalId: string) => {
  const p = childrenOf(db, goalId)[0]!;
  moveTaskTo(db, p.id, "running");
  moveTaskTo(db, p.id, "completed");
};
const keys = (goalId: string) => childrenOf(db, goalId).map((i) => `${i.itemKey}:${i.status}`);

/** A goal with its planner item (the planner run is started), and a plan of the given raw items (valid). */
function setup(raw: Record<string, unknown>[] = [{ key: "a" }, { key: "b", dependsOn: ["a"] }]) {
  db = openDb(":memory:");
  const w = createPlanPort(db, "t").requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const items = raw.map((r) => item(r.key as string, r));
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items,
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  return { goalId: w.goalId, plan: r.plan };
}

test("a superseded version is never approved; the newest version is approved once", () => {
  const { goalId, plan } = setup();
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ add: [item("c")] }),
    reason: "more",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, version: 2, status: "valid" });
  expect(approveVersion(db, plan.id, 1)).toMatchObject({ ok: false, code: "PLAN_NOT_VALID" });
  expect(keys(goalId)).toEqual(["planner:ready"]); // nothing created by the refused v1
  expect(approveVersion(db, plan.id, 2)).toMatchObject({ ok: true, created: ["a", "c", "b"] });
  expect(approveVersion(db, plan.id, 2)).toMatchObject({ ok: false, code: "PLAN_NOT_VALID" });
  expect(keys(goalId)).toEqual([
    "planner:ready",
    "a:ready",
    "c:ready",
    "b:pending",
    "verify-1:pending",
  ]);
  expect(planVersions(db, plan.id).map((v) => v.status)).toEqual(["superseded", "approved"]);
});

test("Orchestrate approve_plan on a superseded version is refused before the owner is asked; a real db port", async () => {
  const { plan } = setup();
  revisePlan(db, { planId: plan.id, baseVersion: 1, edit: edit(), reason: "x", env: ENV });
  const real = createPlanPort(db, "t");
  const port = new FakePort();
  port.plan = real.plan;
  port.decidePlan = real.decidePlan;
  port.answer = { answer: "Approve plan", timedOut: false };
  const ctx = { port, threadId: "t", leadTurnId: "lt", inputId: "in1", run: { dispatched: 0 } };
  expect(await handleApprovePlan(ctx, { planId: plan.id, version: 1 })).toMatchObject({
    code: "PLAN_NOT_VALID",
  });
  expect(port.asked).toHaveLength(0);
  expect(await handleApprovePlan(ctx, { planId: plan.id, version: 2 })).toMatchObject({
    ok: true,
    status: "approved",
  });
  expect(port.asked).toHaveLength(1);
});

test("materialize is one transaction: a failing item insert rolls back every item, event and plan change", () => {
  const { goalId, plan } = setup([
    { key: "model" },
    { key: "api", dependsOn: ["model"] },
    { key: "ui", dependsOn: ["api"] },
  ]);
  // A real db fault on the second item (api): SQLite aborts that insert.
  db.run(
    "CREATE TRIGGER boom BEFORE INSERT ON owned_tasks WHEN NEW.item_key = 'api' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
  );
  expect(() => approveVersion(db, plan.id, 1)).toThrow(/boom/);
  expect(keys(goalId)).toEqual(["planner:ready"]); // `model` was inserted first and rolled back with the rest
  expect(getPlan(db, plan.id, 1)).toMatchObject({ status: "valid", approvedAt: null });
  // Only the planner's start event exists: the plan's start events were rolled back with the items.
  expect(db.query("SELECT COUNT(*) AS n FROM thread_events WHERE kind = 'start'").get()).toEqual({
    n: 1,
  });
  // The fault gone, the same approval applies cleanly once (retry is safe).
  db.run("DROP TRIGGER boom");
  expect(approveVersion(db, plan.id, 1)).toMatchObject({
    ok: true,
    created: ["model", "api", "ui"],
  });
  expect(keys(goalId)).toEqual([
    "planner:ready",
    "model:ready",
    "api:pending",
    "ui:pending",
    "verify-1:pending",
  ]);
});

test("a planner that crashes after storing a valid plan: the goal waits for the owner, then rejection ends the planner only", () => {
  const { goalId, plan } = setup();
  const planner = childrenOf(db, goalId)[0]!;
  moveTaskTo(db, planner.id, "running");
  moveTaskTo(db, planner.id, "failed");
  settleGoal(db, goalId);
  // Not settled: the plan is `valid` and waits. Nothing sweeps it; only the lead (approve / reject) or /stop ends it.
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
  expect(openGoalIdOf(db, "t")).toBe(goalId);
  expect(getPlan(db, plan.id, 1)?.status).toBe("valid");
  expect(rejectVersion(db, plan.id, 1, "owner rejected")).toEqual({ ok: true });
  settleGoal(db, goalId);
  expect(getOwnedTask(db, goalId)?.status).toBe("open"); // the lead may re-plan in this goal
  expect(openGoalIdOf(db, "t")).toBe(goalId);
});

test("a planner that crashes before storing any plan: the goal settles as failed, not open", () => {
  db = openDb(":memory:");
  const w = createPlanPort(db, "t").requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const planner = childrenOf(db, w.goalId)[0]!;
  moveTaskTo(db, planner.id, "running");
  moveTaskTo(db, planner.id, "failed");
  settleGoal(db, w.goalId);
  expect(getOwnedTask(db, w.goalId)?.status).toBe("failed");
  expect(openGoalIdOf(db, "t")).toBeUndefined();
});

test("a revision that cancels an item another item still needs is refused (UNKNOWN_DEP), nothing is stored", () => {
  const { plan } = setup();
  approveVersion(db, plan.id, 1);
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ cancel: ["a"] }), // b depends on a
    reason: "drop a",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: false, code: "INVALID" });
  expect(r.ok === false && r.message).toContain("UNKNOWN_DEP(b)");
  expect(planVersions(db, plan.id).map((v) => v.version)).toEqual([1]);
});

test("the planner cannot be a plan role: the registry and the validator refuse it, Orchestrate dispatch refuses it", () => {
  expect(ENV.workerRoles).not.toContain("planner");
  expect(ENV.workerRoles).not.toContain("lead");
  const doc = (role: string) => ({
    items: [item("a", { role })],
    acceptanceCriteria: [],
    envelope: buildEnvelope(
      { locations: ["repo"], riskClasses: ["R1"], bounds: { maxItems: 8, maxGb: 1 } },
      [item("a", { role })],
      1,
      [],
    ),
  });
  const ctx = {
    workerRoles: ENV.workerRoles,
    locations: ["repo"],
    existingKeys: [],
    revisions: 0,
  };
  for (const role of ["planner", "lead"])
    expect(validatePlan(doc(role), ctx).map((e) => e.code)).toEqual(["UNKNOWN_ROLE"]);
  const state = { items: [] };
  const caps = { chainCount: 0, dispatchedThisRun: 0 };
  const dispatch = checkDispatch(
    state,
    {
      strategy: "DIRECT",
      assignments: [{ key: "p", subject: "task", role: "planner", brief: "x", dependsOn: [] }],
    } as never,
    caps,
    { workerRoles: ENV.workerRoles, locations: ["repo"] },
  );
  expect(dispatch).toMatchObject({ ok: false, code: "NOT_WORKER" });
});

test("the planner has no write, shell or subagent tool: the SDK tool set and the guard both say so", () => {
  const p = ROLES.planner!;
  expect(toolsFor(p).sort()).toEqual(["Glob", "Grep", "LSP", "Read", "Skill"]);
  expect(toolOptions(p).tools).not.toContain("Bash");
  const g = guardFor(p, { readPaths: ["/r"] });
  for (const t of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent"])
    expect([t, checkToolCall(t, { command: "ls" }, g).decision]).toEqual([t, "deny"]);
  expect(p.sideEffects).toBe("none");
  expect(p.noSubagents).toBe(true);
});

test("a revision that makes a new item wait on a FAILED item is refused (DEAD_DEP): the goal is not held open forever", () => {
  const { goalId, plan } = setup([{ key: "a" }, { key: "b" }]);
  finishPlanner(goalId);
  approveVersion(db, plan.id, 1);
  const byKey = (k: string) => childrenOf(db, goalId).find((i) => i.itemKey === k)!;
  moveTaskTo(db, byKey("a").id, "running");
  moveTaskTo(db, byKey("a").id, "failed");
  cancelDependents(db, byKey("a").id); // what the worker end does: the verify waiting for a can never run
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ add: [item("z", { dependsOn: ["a"] })] }),
    reason: "retry after a",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: false, code: "INVALID" });
  expect(r.ok === false && r.message).toContain("DEAD_DEP(z)");
  expect(planVersions(db, plan.id).map((v) => v.version)).toEqual([1]); // nothing stored
  moveTaskTo(db, byKey("b").id, "running");
  moveTaskTo(db, byKey("b").id, "completed");
  settleGoal(db, goalId);
  expect(getOwnedTask(db, goalId)?.status).toBe("failed"); // a failed: the goal ends
});
