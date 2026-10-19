import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { MAX_WAVES, PENDING_PLAN_MAX_AGE_MS } from "../src/config/lead-caps";
import { renderUserNotice, type UserNotice } from "../src/ingress/user-copy";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { ASK_OWNER_TIMEOUT_MS } from "../src/orchestrator/lead/lead-limits";
import { handleApprovePlan } from "../src/orchestrator/lead/lead-plan-handlers";
import type { LeadRuntime } from "../src/orchestrator/lead/lead-runtime";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { revisePlan } from "../src/orchestrator/plan/plan-revision";
import { createPlanHandler, type PlannerCtx } from "../src/orchestrator/plan/planner-handlers";
import { insertPlannerItem } from "../src/orchestrator/plan/planner-item";
import { dispatchReady } from "../src/orchestrator/worker/dispatch-ready";
import { sweepPendingPlans } from "../src/orchestrator/worker/plan-expiry";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { setResultKind } from "../src/storage/owned-item-store";
import { getOwnedTask, insertOwnedTask } from "../src/storage/owned-task-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { planVersions } from "../src/storage/work-plan-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { FakePort, leadCtx } from "./lead-fake-port";
import { approvedPlan, byKey, ENV, item, keysOf, TH } from "./waves-fixture";

/* Re-plan after a rejected or expired plan, owner-gated re-plans, released dependencies, owner copy (review of phase 2). */

let db: Database;
afterEach(() => db?.close());
const edit = (over: object = {}) => ({ add: [], cancel: [], modify: [], ...over });
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};
const planArgs = (goalId: string, items: ReturnType<typeof item>[]) => ({
  goalId,
  objective: "build it",
  items,
  acceptanceCriteria: ["works"],
  envelope: ENVELOPE,
  budgetUsd: 3,
  effects: [],
  env: ENV,
});
const plannerCtx = (goalId: string): PlannerCtx => ({
  db,
  threadId: TH,
  goalId,
  workers: dispatchableWorkers(),
  locations: [{ name: "repo", path: "/x" }],
  channelDigest: () => "",
});
/** A fresh db with one open goal (planner item ready). */
function openGoal(): string {
  db = openDb(":memory:");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  return w.goalId;
}
/** An open goal with a `valid` plan v1. */
function validPlan(items = [item("p1")]) {
  const goalId = openGoal();
  const r = createPlan(db, planArgs(goalId, items));
  if (!r.ok) throw new Error(r.message);
  return { goalId, plan: r.plan };
}
const finishPlanner = (goalId: string, key = "planner") => {
  const p = byKey(db, goalId, key);
  moveTaskTo(db, p.id, "running");
  moveTaskTo(db, p.id, "completed");
};
function needsPlanning(goalId: string, key: string, hold = true) {
  const id = crypto.randomUUID();
  insertOwnedTask(db, {
    id,
    threadId: TH,
    ownerRole: "developer",
    status: "ready",
    scope: key,
    correlationId: goalId,
    parentId: goalId,
    itemKey: key,
    dependsOn: [],
    brief: `do ${key}`,
  });
  moveTaskTo(db, id, "running");
  if (hold) {
    moveTaskTo(db, id, "blocked");
    setResultKind(db, id, "NEEDS_PLANNING");
  }
  return id;
}

test("H1: reject -> RequestPlan(goalId) -> CreatePlan -> valid -> ApprovePlan inside the same goal", async () => {
  const { goalId, plan } = validPlan();
  needsPlanning(goalId, "x"); // a DELEGATE goal: the goal stays open after the reject
  finishPlanner(goalId);
  const real = createPlanPort(db, TH);
  const port = new FakePort();
  port.plan = real.plan;
  port.decidePlan = real.decidePlan;
  port.answer = { answer: "Reject plan", timedOut: false };
  const rej = await handleApprovePlan(leadCtx(port), { planId: plan.id, version: 1 });
  expect(rej).toMatchObject({ ok: true, status: "rejected" });
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
  const w = real.requestPlan({ key: "k2", objective: "again", goalId });
  expect(w).toMatchObject({ ok: true, goalId });
  const made = createPlanHandler(plannerCtx(goalId), {
    ...planArgs(goalId, [item("q1")]),
  });
  expect(made).toMatchObject({ ok: true, planId: plan.id, version: 2, status: "valid" });
  port.answer = { answer: "Approve plan", timedOut: false };
  const ok = await handleApprovePlan(leadCtx(port, "in2"), { planId: plan.id, version: 2 });
  expect(ok).toMatchObject({ ok: true, status: "approved" });
  expect(keysOf(db, goalId)).toContain("q1:ready");
});

test("H1: CreatePlan is still refused while a version is valid or approved", () => {
  const { goalId } = validPlan();
  expect(createPlan(db, planArgs(goalId, [item("z")]))).toMatchObject({
    ok: false,
    code: "PLAN_EXISTS",
  });
  const a = approvedPlan([item("a")]);
  db = a.db;
  expect(createPlan(db, planArgs(a.goalId, [item("z")]))).toMatchObject({
    ok: false,
    code: "PLAN_EXISTS",
  });
});

test("H1: a revision whose newest version was rejected bases on the newest approved version", () => {
  const a = approvedPlan([item("a")]);
  db = a.db;
  const grown = { ...ENVELOPE, bounds: { maxItems: 8, maxGb: 5 } };
  const v2 = revisePlan(db, {
    planId: a.planId,
    baseVersion: 1,
    edit: edit({ envelope: grown }),
    reason: "x",
    env: ENV,
  });
  expect(v2).toMatchObject({ ok: true, status: "valid" });
  expect(rejectVersion(db, a.planId, 2, "no")).toMatchObject({ ok: true });
  const stale = revisePlan(db, {
    planId: a.planId,
    baseVersion: 7,
    edit: edit({ add: [item("z")] }),
    reason: "again",
    env: ENV,
  });
  expect(stale).toMatchObject({ ok: false, code: "STALE_VERSION" });
  // The planner read the newest version (2, rejected): it is accepted, the approved v1 is the base.
  const v3 = revisePlan(db, {
    planId: a.planId,
    baseVersion: 2,
    edit: edit({ add: [item("z")] }),
    reason: "again",
    env: ENV,
  });
  expect(v3).toMatchObject({ ok: true, version: 3, status: "approved" });
  expect(planVersions(db, a.planId).map((v) => v.status)).toEqual([
    "superseded",
    "rejected",
    "approved",
  ]);
  expect(keysOf(db, a.goalId)).toContain("z:ready");
});

test("M1: a re-plan past MAX_WAVES says it is a re-plan approved by the owner", () => {
  const { goalId } = validPlan();
  for (let n = 1; n < MAX_WAVES; n++)
    insertPlannerItem(db, {
      goalId,
      threadId: TH,
      correlationId: goalId,
      objective: "o",
      brief: "b",
      eventId: (k) => `extra:${k}`,
      payload: {},
    });
  const w = createPlanPort(db, TH).requestPlan({ key: "k9", objective: "o", goalId });
  expect(w.ok).toBe(true);
  const brief = byKey(db, goalId, `planner-${MAX_WAVES + 1}`).brief ?? "";
  expect(brief).toContain(`re-plan ${MAX_WAVES + 1}`);
  expect(brief).toContain("owner");
  expect(brief).not.toContain("of at most");
});

test("M2: a plan item that waits for a NEEDS_PLANNING item the approval will release is refused", () => {
  const goalId = openGoal();
  needsPlanning(goalId, "x");
  const r = createPlan(db, planArgs(goalId, [item("p2", { dependsOn: ["x"] })]));
  expect(r).toMatchObject({ ok: false, code: "INVALID" });
  expect(r.ok === false && r.message).toContain("RELEASED_DEP");
  expect(r.ok === false && r.message).toContain("x");
});

test("M2 backstop: a dependency that became NEEDS_PLANNING after validation is re-pointed with an event", () => {
  const goalId = openGoal();
  const x = needsPlanning(goalId, "x", false); // running: a fine dependency when the plan is stored
  const r = createPlan(db, planArgs(goalId, [item("p2", { dependsOn: ["x"] })]));
  if (!r.ok) throw new Error(r.message);
  moveTaskTo(db, x, "blocked");
  setResultKind(db, x, "NEEDS_PLANNING");
  finishPlanner(goalId);
  expect(approveVersion(db, r.plan.id, 1)).toMatchObject({ ok: true });
  expect(byKey(db, goalId, "p2").dependsOn).toEqual([]);
  const ev = listUndelivered(db, TH).find((e) => e.kind === "plan_revised");
  expect(JSON.stringify(ev?.payload)).toContain("p2");
});

test("L3: releasing a NEEDS_PLANNING item with nothing waiting writes no plan_revised event", () => {
  const { goalId, plan } = validPlan();
  needsPlanning(goalId, "x");
  finishPlanner(goalId);
  expect(approveVersion(db, plan.id, 1)).toMatchObject({ ok: true, cancelled: ["x"] });
  expect(listUndelivered(db, TH).some((e) => e.kind === "plan_revised")).toBe(false);
});

const rtOf = (announced: string[]) =>
  ({ deps: { db }, announce: (t: string) => announced.push(t) }) as unknown as LeadRuntime;

test("L2: expiry waits for an owner answer that was asked just before the limit", () => {
  validPlan();
  const base = Date.now() + PENDING_PLAN_MAX_AGE_MS + 1000;
  expect(sweepPendingPlans(rtOf([]), base)).toBe(0);
  expect(sweepPendingPlans(rtOf([]), base + ASK_OWNER_TIMEOUT_MS)).toBe(1);
});

test("L1: owner notices are localized and keep ids out", () => {
  const closed: UserNotice = { kind: "plan-not-started", cause: "closed" };
  expect(renderUserNotice(closed, "en")).not.toBe(renderUserNotice(closed, "vi"));
  const diff: UserNotice = {
    kind: "plan-revised",
    cancelled: ["a"],
    added: [],
    modified: [],
    criteriaChanged: true,
    reason: "scope cut",
  };
  const en = renderUserNotice(diff, "en");
  expect(en).toContain("cancelled: a");
  expect(en).toContain("scope cut");
  expect(renderUserNotice(diff, "vi")).toContain("đã hủy: a");
});

test("L1: a refusal after the click is posted as a notice without the internal message", async () => {
  const port = new FakePort();
  port.plans.set("p1:1", {
    planId: "p1",
    version: 1,
    status: "valid",
    goalId: "g1",
    objective: "o",
    doc: {
      items: [{ key: "a", role: "developer", brief: "do a", dependsOn: [], risk: "R1" }],
      acceptanceCriteria: ["works"],
      envelope: {
        roles: ["developer"],
        locations: [],
        riskClasses: ["R1"],
        bounds: { maxItems: 8, maxGb: 1 },
        budgetUsd: 3,
        effects: [],
      },
    },
  });
  port.answer = { answer: "Approve plan", timedOut: false };
  port.decidePlan = () => ({
    ok: false,
    code: "GOAL_CLOSED",
    message: "Goal 7c9e6679-7425-40de-944b-e07fc1f90ae7 is no longer open",
  });
  await handleApprovePlan({ ...leadCtx(port), language: "en" }, { planId: "p1", version: 1 });
  expect(port.posts[0]?.text).toBe(
    renderUserNotice({ kind: "plan-not-started", cause: "closed" }, "en"),
  );
  expect(port.posts[0]?.text).not.toContain("7c9e");
});

test("B6 wiring: the dispatch pass cancels a pending item whose dependency ended cancelled", async () => {
  const a = approvedPlan([item("a"), item("b", { dependsOn: ["a"] })]);
  db = a.db;
  moveTaskTo(db, byKey(db, a.goalId, "a").id, "cancelled"); // a plain status move: no cascade
  const announced: string[] = [];
  const rt = {
    deps: { db, stopping: () => false },
    ctxOf: () => ({}),
    announce: (t: string) => announced.push(t),
  } as unknown as LeadRuntime;
  await dispatchReady(rt, TH);
  expect(byKey(db, a.goalId, "b").status).toBe("cancelled");
  expect(announced).toContain(TH);
});
