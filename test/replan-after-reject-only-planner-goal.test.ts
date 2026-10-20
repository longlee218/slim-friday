import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { PENDING_PLAN_MAX_AGE_MS } from "../src/config/lead-caps";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { ASK_OWNER_TIMEOUT_MS } from "../src/orchestrator/lead/lead-limits";
import { handleApprovePlan } from "../src/orchestrator/lead/lead-plan-handlers";
import type { LeadRuntime } from "../src/orchestrator/lead/lead-runtime";
import { createPlan } from "../src/orchestrator/plan/plan-lifecycle";
import { settleGoal } from "../src/orchestrator/worker/goal-settle";
import { sweepPendingPlans } from "../src/orchestrator/worker/plan-expiry";
import { openDb } from "../src/storage/db";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { FakePort, leadCtx } from "./lead-fake-port";
import { byKey, ENV, item, TH } from "./waves-fixture";

/* A PLAN goal whose only item is its planner stays open when the plan is rejected or expires: the lead re-plans in the same goal. */

let db: Database;
afterEach(() => db?.close());
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};

/** A goal with only its finished planner item and a `valid` plan v1. */
function plannedGoal() {
  db = openDb(":memory:");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items: [item("p1")],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  const p = byKey(db, w.goalId, "planner");
  moveTaskTo(db, p.id, "running");
  moveTaskTo(db, p.id, "completed");
  return { goalId: w.goalId, plan: r.plan };
}

test("owner rejects the only plan: the goal stays open and request_plan restarts a planner", async () => {
  const { goalId, plan } = plannedGoal();
  const real = createPlanPort(db, TH);
  const port = new FakePort();
  port.plan = real.plan;
  port.decidePlan = real.decidePlan;
  port.answer = { answer: "Reject plan", timedOut: false };
  const rej = await handleApprovePlan(leadCtx(port), { planId: plan.id, version: 1 });
  expect(rej).toMatchObject({ ok: true, status: "rejected" });
  settleGoal(db, goalId); // the dispatch pass settles too: still open
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
  expect(real.requestPlan({ key: "k2", objective: "again", goalId })).toMatchObject({
    ok: true,
    goalId,
  });
});

test("the only plan expires: the goal stays open and request_plan restarts a planner", () => {
  const { goalId } = plannedGoal();
  const now = Date.now() + PENDING_PLAN_MAX_AGE_MS + 1000 + ASK_OWNER_TIMEOUT_MS;
  const rt = { deps: { db }, announce: () => {} } as unknown as LeadRuntime;
  expect(sweepPendingPlans(rt, now)).toBe(1);
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
  const real = createPlanPort(db, TH);
  expect(real.requestPlan({ key: "k3", objective: "again", goalId })).toMatchObject({
    ok: true,
    goalId,
  });
});
