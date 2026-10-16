import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { CHAIN_CAP } from "../src/config/lead-caps";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { goalCaps, openGoalIdOf } from "../src/orchestrator/goal/effect-port-queries";
import { handleApprovePlan } from "../src/orchestrator/lead/lead-plan-handlers";
import { toPlanItem } from "../src/orchestrator/plan/plan-doc";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { renderPlan } from "../src/orchestrator/plan/plan-render";
import { type Edit, revisePlan } from "../src/orchestrator/plan/plan-revision";
import { stopThreadTree } from "../src/orchestrator/run/stop-thread-tree";
import { checkPlanRequest } from "../src/orchestrator/strategy/plan-policy";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { childrenOf } from "../src/storage/owned-item-store";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { appendEvent } from "../src/storage/thread-event-store";
import {
  getPlan,
  hasPendingPlan,
  PENDING_PLAN_MAX_AGE_MS,
  planVersions,
} from "../src/storage/work-plan-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { FakePort } from "./lead-fake-port";

/* Review fixes of phase L2b over a real in-memory db: chain cap, rendering, pending plans, atomic approve / revise /
   reject, dead dependencies, revision of the acceptance criteria. */

let db: Database;
afterEach(() => db?.close());
const ENV = {
  workerRoles: dispatchableWorkers().map((r) => r.name),
  locations: ["repo"],
  goalBudgetUsd: 6,
};
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};
const item = (key: string, over: Record<string, unknown> = {}) =>
  toPlanItem({ key, role: "developer", brief: `do ${key}`, dependsOn: [], risk: "R1", ...over });
const edit = (over: Partial<Edit> = {}): Edit => ({ add: [], cancel: [], modify: [], ...over });
const byKey = (goalId: string, k: string) => childrenOf(db, goalId).find((i) => i.itemKey === k)!;
const keys = (goalId: string) => childrenOf(db, goalId).map((i) => `${i.itemKey}:${i.status}`);

/** A goal with its planner item and a `valid` plan of the given items. */
function setup(raw: string[] = ["a", "b", "c"]) {
  db = openDb(":memory:");
  const w = createPlanPort(db, "t").requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items: raw.map((k) => item(k)),
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    budgetUsd: 3,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  return { goalId: w.goalId, plan: r.plan };
}
const finishPlanner = (goalId: string) => {
  const p = byKey(goalId, "planner");
  moveTaskTo(db, p.id, "running");
  moveTaskTo(db, p.id, "completed");
};

test("H1: starts of an approved plan are not chained; the planner start and a plain start are", () => {
  const { goalId, plan } = setup();
  expect(approveVersion(db, plan.id, 1)).toMatchObject({ ok: true, created: ["a", "b", "c"] });
  const caps = goalCaps(db, "t", Date.now());
  expect(caps.chainCount).toBe(1); // the planner's start only
  expect(
    checkPlanRequest(
      { openGoalId: goalId, items: [] },
      { goalId },
      { ...caps, dispatchedThisRun: 0 },
    ),
  ).toEqual({ ok: true });
  for (let n = 0; n < CHAIN_CAP - 1; n++)
    appendEvent(db, { id: `d${n}`, threadId: "t", kind: "start", payload: { key: `x${n}` } });
  expect(goalCaps(db, "t", Date.now()).chainCount).toBe(CHAIN_CAP); // plain starts still count
});

test("H2: the rendered plan carries each brief, the objective and the criteria in full", () => {
  const brief = `${"b".repeat(3990)}END`;
  const objective = `${"o".repeat(300)}OBJ_END`;
  const text = renderPlan({
    version: 1,
    objective,
    doc: {
      items: [{ key: "a", role: "developer", brief, dependsOn: [], risk: "R1" }],
      acceptanceCriteria: ["c".repeat(290)],
      envelope: {
        roles: ["developer"],
        locations: [],
        riskClasses: ["R1"],
        bounds: { maxItems: 8, maxGb: 1 },
        budgetUsd: 1,
        effects: [],
      },
    },
  });
  expect(text).toContain(brief);
  expect(text).toContain(objective);
  expect(text).toContain("c".repeat(290));
  expect(text.split("\n")[0]!.length).toBeLessThan(160); // the inline stem stays short
  expect(text).toContain("Full briefs are in the attachment");
});

test("M1/D2: /stop closes the pending plan; an approve answered after it creates nothing", async () => {
  const { goalId, plan } = setup();
  const real = createPlanPort(db, "t");
  const port = new FakePort();
  port.plan = real.plan;
  port.decidePlan = real.decidePlan;
  port.askOwner = async () => {
    stopThreadTree(db, "t"); // the owner types /stop while the question is open
    return { answer: "Approve plan", timedOut: false };
  };
  const ctx = { port, threadId: "t", leadTurnId: "lt", inputId: "in1", run: { dispatched: 0 } };
  expect(await handleApprovePlan(ctx, { planId: plan.id, version: 1 })).toMatchObject({
    ok: false,
  });
  expect(getPlan(db, plan.id, 1)?.status).toBe("rejected");
  expect(keys(goalId)).toEqual(["planner:cancelled"]);
  expect(getOwnedTask(db, goalId)?.status).toBe("cancelled");
});

test("M1: CancelTask of the goal closes its pending plan", () => {
  const { goalId, plan } = setup();
  const port = createDbEffectPort({
    db,
    threadId: "t",
    env: { workerRoles: ENV.workerRoles, locations: ENV.locations },
    io: {
      steerTask: () => "none",
      askOwner: async () => ({ timedOut: true }),
      post: async () => {},
    },
  });
  port.cancel(goalId, "test");
  expect(getPlan(db, plan.id, 1)?.status).toBe("rejected");
  expect(approveVersion(db, plan.id, 1)).toMatchObject({ ok: false }); // goal closed too
  expect(keys(goalId)).toEqual(["planner:cancelled"]);
});

test("M1: an approved plan whose revision is pending ends `superseded`, not `rejected`, on /stop", () => {
  const { goalId, plan } = setup();
  finishPlanner(goalId);
  approveVersion(db, plan.id, 1);
  const grown = { ...ENVELOPE, bounds: { maxItems: 8, maxGb: 5 } };
  revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ envelope: grown }),
    reason: "x",
    env: ENV,
  });
  expect(getPlan(db, plan.id, 2)?.status).toBe("valid");
  stopThreadTree(db, "t");
  expect(planVersions(db, plan.id).map((v) => v.status)).toEqual(["approved", "superseded"]);
});

test("M1: a valid plan older than the limit no longer holds the goal open", () => {
  const { goalId } = setup();
  finishPlanner(goalId);
  const now = Date.now();
  expect(hasPendingPlan(db, goalId, now)).toBe(true);
  expect(openGoalIdOf(db, "t", now)).toBe(goalId);
  const later = now + PENDING_PLAN_MAX_AGE_MS + 1000;
  expect(hasPendingPlan(db, goalId, later)).toBe(false);
  expect(openGoalIdOf(db, "t", later)).toBeUndefined();
});

test("M2: approving a plan of a goal that is no longer open is refused and creates nothing", () => {
  const { goalId, plan } = setup();
  moveTaskTo(db, goalId, "cancelled");
  expect(approveVersion(db, plan.id, 1)).toMatchObject({ ok: false, code: "GOAL_CLOSED" });
  expect(keys(goalId)).toEqual(["planner:ready"]);
  expect(getPlan(db, plan.id, 1)?.status).toBe("valid");
});

test("M3: an approved revision is one transaction: a failing item insert leaves no new version", () => {
  const { goalId, plan } = setup(["a", "b"]);
  finishPlanner(goalId);
  approveVersion(db, plan.id, 1);
  db.run(
    "CREATE TRIGGER boom BEFORE INSERT ON owned_tasks WHEN NEW.item_key = 'z' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
  );
  expect(() =>
    revisePlan(db, {
      planId: plan.id,
      baseVersion: 1,
      edit: edit({ add: [item("z")] }),
      reason: "more",
      env: ENV,
    }),
  ).toThrow(/boom/);
  expect(planVersions(db, plan.id).map((v) => `${v.version}:${v.status}`)).toEqual(["1:approved"]);
  expect(keys(goalId)).toEqual(["planner:completed", "a:ready", "b:ready"]);
});

test("M3: a revision of a plan whose goal closed is refused and stores no version", () => {
  const { goalId, plan } = setup(["a", "b"]);
  finishPlanner(goalId);
  approveVersion(db, plan.id, 1);
  moveTaskTo(db, goalId, "cancelled");
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ add: [item("z")] }),
    reason: "more",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: false, code: "GOAL_CLOSED" });
  expect(planVersions(db, plan.id).map((v) => v.version)).toEqual([1]);
});

test("M5: reject is one transaction: a failing cancel leaves the plan valid", () => {
  const { goalId, plan } = setup();
  db.run(
    "CREATE TRIGGER boom BEFORE UPDATE ON owned_tasks WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
  );
  expect(() => rejectVersion(db, plan.id, 1, "no")).toThrow(/boom/);
  expect(getPlan(db, plan.id, 1)?.status).toBe("valid");
  expect(keys(goalId)).toEqual(["planner:ready"]);
});

test("D1: a new item may not wait on a cancelled item either", () => {
  const { goalId, plan } = setup(["a", "b"]);
  finishPlanner(goalId);
  approveVersion(db, plan.id, 1);
  moveTaskTo(db, byKey(goalId, "a").id, "cancelled");
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ add: [item("z", { dependsOn: ["a"] })] }),
    reason: "x",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: false, code: "INVALID" });
  expect(r.ok === false && r.message).toContain("DEAD_DEP(z)");
  // A completed dependency stays valid.
  moveTaskTo(db, byKey(goalId, "b").id, "running");
  moveTaskTo(db, byKey(goalId, "b").id, "completed");
  expect(
    revisePlan(db, {
      planId: plan.id,
      baseVersion: 1,
      edit: edit({ add: [item("y", { dependsOn: ["b"] })] }),
      reason: "x",
      env: ENV,
    }),
  ).toMatchObject({ ok: true, status: "approved" });
});

test("Low: a revision may replace the acceptance criteria", () => {
  const { plan } = setup(["a"]);
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ acceptanceCriteria: ["new one", "second"] }),
    reason: "x",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, version: 2 });
  expect(JSON.parse(getPlan(db, plan.id, 2)!.acceptance)).toEqual(["new one", "second"]);
});

test("Low: an envelope location the workspace does not have is refused; items without location are fine", () => {
  const { plan } = setup(["a"]); // `a` has no location: valid
  const r = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ envelope: { ...ENVELOPE, locations: ["repo", "ghost"] } }),
    reason: "x",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: false, code: "INVALID" });
  expect(r.ok === false && r.message).toContain("BAD_LOCATION");
});
