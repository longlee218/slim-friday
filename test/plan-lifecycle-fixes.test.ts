import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { PENDING_PLAN_MAX_AGE_MS } from "../src/config/lead-caps";
import { renderUserNotice } from "../src/ingress/user-copy";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { pendingNews } from "../src/orchestrator/lead/lead-events";
import { ASK_OWNER_TIMEOUT_MS } from "../src/orchestrator/lead/lead-limits";
import { handleApprovePlan } from "../src/orchestrator/lead/lead-plan-handlers";
import type { LeadRuntime } from "../src/orchestrator/lead/lead-runtime";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { type RevisionDiff, revisionNotice } from "../src/orchestrator/plan/plan-revised";
import { revisePlan } from "../src/orchestrator/plan/plan-revision";
import {
  noteWaveHold,
  startNextWave,
  waveHeldGoalOf,
  waveOutlook,
} from "../src/orchestrator/plan/plan-waves";
import { type PlannerCtx, proposeRevisionHandler } from "../src/orchestrator/plan/planner-handlers";
import { checkPlanRequest } from "../src/orchestrator/strategy/plan-policy";
import { cancelDeadWaiters, settleGoal } from "../src/orchestrator/worker/goal-settle";
import { sweepPendingPlans } from "../src/orchestrator/worker/plan-expiry";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { setResultKind } from "../src/storage/owned-item-store";
import { getOwnedTask, insertOwnedTask } from "../src/storage/owned-task-store";
import { appendEvent, listUndelivered } from "../src/storage/thread-event-store";
import { getPlan, planVersions } from "../src/storage/work-plan-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { FakePort, itemRow, leadCtx } from "./lead-fake-port";
import { approvedPlan, byKey, complete, ENV, item, keysOf, spend, TH } from "./waves-fixture";

/* Plan lifecycle fixes (phase 2 of the orchestration hardening; B<n> = finding n of the boundary audit). */

let db: Database;
afterEach(() => db?.close());
const edit = (over: object = {}) => ({ add: [], cancel: [], modify: [], ...over });
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};

/** A goal (planner item still ready) with a `valid` plan v1. */
function validPlan(keys = ["a", "b"]) {
  db = openDb(":memory:");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items: keys.map((k) => item(k)),
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  return { goalId: w.goalId, plan: r.plan };
}
/** `approvedPlan` that also keeps its db for the test's cleanup. */
function approved(items: ReturnType<typeof item>[]) {
  const p = approvedPlan(items);
  db = p.db;
  return p;
}
const finishPlanner = (goalId: string) => {
  const p = byKey(db, goalId, "planner");
  moveTaskTo(db, p.id, "running");
  moveTaskTo(db, p.id, "completed");
};
/** An item a DELEGATE worker reported NEEDS_PLANNING for (held `blocked`). */
function needsPlanning(goalId: string, key: string, dependsOn: string[] = []) {
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
    dependsOn,
    brief: `do ${key}`,
  });
  return id;
}
const holdNeedsPlanning = (id: string) => {
  moveTaskTo(db, id, "running");
  moveTaskTo(db, id, "blocked");
  setResultKind(db, id, "NEEDS_PLANNING");
};
const view = (over: Record<string, unknown> = {}) => ({
  planId: "p1",
  version: 1,
  status: "valid" as const,
  goalId: "g1",
  objective: "build it",
  doc: {
    items: [
      {
        key: "a",
        subject: "task",
        role: "developer",
        brief: "do a",
        dependsOn: [],
        risk: "R1" as const,
      },
    ],
    acceptanceCriteria: ["works"],
    envelope: {
      roles: ["developer"],
      locations: [],
      riskClasses: ["R1" as const],
      bounds: { maxItems: 8, maxGb: 1 },
      budgetUsd: 3,
      effects: [],
    },
  },
  ...over,
});

test("B1: the owner's typed text comes back on UNCLEAR; a reject says no reason was given", async () => {
  const port = new FakePort();
  port.plans.set("p1:1", view());
  port.answer = { answer: "step 3 should use Postgres, not SQLite", timedOut: false };
  const r = await handleApprovePlan(leadCtx(port), { planId: "p1", version: 1 });
  expect(r).toMatchObject({ ok: false, code: "UNCLEAR" });
  expect(r.ok === false && r.message).toContain("step 3 should use Postgres");
  expect(r.ok === false && r.message).toContain("Orchestrate request_plan");
  expect(port.decisions).toHaveLength(0);
  port.answer = { answer: "Reject plan", timedOut: false };
  const rej = await handleApprovePlan(leadCtx(port, "in2"), { planId: "p1", version: 1 });
  expect(rej).toMatchObject({ ok: true, status: "rejected" });
  expect(rej).toMatchObject({
    ok: true,
    note: "The owner gave no reason: ask what to change before you plan again.",
  });
});

test("B3: a revision that cancels a started item and changes the criteria applies, emits plan_revised and notifies", () => {
  const { goalId, planId } = approved([item("a"), item("b")]);
  const a = byKey(db, goalId, "a");
  moveTaskTo(db, a.id, "running");
  const notes: RevisionDiff[] = [];
  const ctx: PlannerCtx = {
    db,
    threadId: TH,
    goalId,
    workers: dispatchableWorkers(),
    locations: [{ name: "repo", path: "/x" }],
    channelDigest: () => "",
    notify: (t) => notes.push(t),
  };
  const r = proposeRevisionHandler(ctx, {
    planId,
    baseVersion: 1,
    add: [],
    cancel: ["a"],
    modify: [],
    acceptanceCriteria: ["weaker"],
    reason: "scope cut",
  });
  expect(r).toMatchObject({ ok: true, status: "approved" });
  expect(byKey(db, goalId, "a").status).toBe("cancelled");
  const ev = listUndelivered(db, TH).find((e) => e.kind === "plan_revised");
  expect(ev?.taskId).toBe(goalId);
  expect(ev?.payload).toMatchObject({
    version: 2,
    cancelled: ["a"],
    criteriaChanged: true,
    reason: "scope cut",
  });
  expect(pendingNews(db, TH).map((e) => e.kind)).toContain("plan_revised"); // wakes the lead
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    version: 2,
    cancelled: ["a"],
    criteriaChanged: true,
    reason: "scope cut",
  });
  // What the owner reads: the version line with the cancelled key, in his language.
  const text = renderUserNotice(revisionNotice(notes[0] as RevisionDiff), "en");
  expect(text).toContain("Plan v1 → v2: +0, −1, ~0 (cancelled: a)");
});

test("B3: a plain addition emits no plan_revised event; the owner gets the one version line", () => {
  const { goalId, planId } = approved([item("a")]);
  const notes: RevisionDiff[] = [];
  const ctx: PlannerCtx = {
    db,
    threadId: TH,
    goalId,
    workers: dispatchableWorkers(),
    locations: [{ name: "repo", path: "/x" }],
    channelDigest: () => "",
    notify: (t) => notes.push(t),
  };
  const r = proposeRevisionHandler(ctx, {
    planId,
    baseVersion: 1,
    add: [item("z")],
    cancel: [],
    modify: [],
    reason: "more",
  });
  expect(r).toMatchObject({ ok: true, status: "approved" });
  expect(listUndelivered(db, TH).some((e) => e.kind === "plan_revised")).toBe(false);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ version: 2, added: ["z"], cancelled: [] });
});

test("B4: a plan that dropped a not-started item by revision settles `completed`, not `cancelled`", () => {
  const { goalId, planId } = approved([item("a"), item("b")]);
  expect(
    revisePlan(db, {
      planId,
      baseVersion: 1,
      edit: edit({ cancel: ["b"] }),
      reason: "x",
      env: ENV,
    }),
  ).toMatchObject({ ok: true, status: "approved" });
  complete(db, goalId, "a");
  complete(db, goalId, "verify-1");
  settleGoal(db, goalId);
  expect(getOwnedTask(db, goalId)?.status).toBe("completed");
});

test("B4: an item the lead cancelled still counts: the goal settles `cancelled`", () => {
  const { goalId, planId } = approved([item("a"), item("b")]);
  revisePlan(db, { planId, baseVersion: 1, edit: edit({ cancel: ["b"] }), reason: "x", env: ENV });
  const b = byKey(db, goalId, "b").id;
  // The lead's Orchestrate cancel event names the item: the owner's side stopped this work, it is not a plan drop.
  appendEvent(db, {
    id: `cancel:${b}`,
    threadId: TH,
    taskId: goalId,
    itemId: b,
    kind: "cancel",
    payload: { reason: "stop", cancelled: [b] },
  });
  complete(db, goalId, "a");
  complete(db, goalId, "verify-1");
  settleGoal(db, goalId);
  expect(getOwnedTask(db, goalId)?.status).toBe("cancelled");
});

test("B4: a released NEEDS_PLANNING item does not make a successful plan `cancelled`", () => {
  const { goalId, plan } = validPlan(["p1"]);
  holdNeedsPlanning(needsPlanning(goalId, "x"));
  finishPlanner(goalId);
  expect(approveVersion(db, plan.id, 1)).toMatchObject({ ok: true, cancelled: ["x"] });
  complete(db, goalId, "p1");
  complete(db, goalId, "verify-1");
  settleGoal(db, goalId);
  expect(getOwnedTask(db, goalId)?.status).toBe("completed");
});

test("B6: a pending item whose dependency ended cancelled is cancelled by the pass backstop, with an event", () => {
  const { goalId } = approved([item("a"), item("b", { dependsOn: ["a"] })]);
  moveTaskTo(db, byKey(db, goalId, "a").id, "cancelled"); // no cascade: a plain status move
  expect(cancelDeadWaiters(db, goalId)).toEqual(expect.arrayContaining(["b"]));
  expect(byKey(db, goalId, "b").status).toBe("cancelled");
  expect(
    listUndelivered(db, TH).some(
      (e) => e.kind === "failure" && e.itemId === byKey(db, goalId, "b").id,
    ),
  ).toBe(true);
});

test("B5: rejecting a plan inside a DELEGATE goal cancels the planner only; the running sibling keeps going", () => {
  const { goalId, plan } = validPlan(["p1"]);
  holdNeedsPlanning(needsPlanning(goalId, "a"));
  const b = needsPlanning(goalId, "b");
  moveTaskTo(db, b, "running");
  finishPlanner(goalId);
  expect(rejectVersion(db, plan.id, 1, "no")).toMatchObject({ ok: true });
  expect(byKey(db, goalId, "b").status).toBe("running");
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
  expect(getPlan(db, plan.id, 1)?.status).toBe("rejected");
});

test("B5: rejecting the plan of a pure PLAN goal ends the planner only; the goal stays open for a re-plan", () => {
  const { goalId, plan } = validPlan(["p1"]);
  expect(rejectVersion(db, plan.id, 1, "no")).toMatchObject({ ok: true });
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
  expect(byKey(db, goalId, "planner").status).toBe("cancelled");
});

test("B6: a dependent of a released NEEDS_PLANNING item is cancelled with an event; none stays pending", () => {
  const { goalId, plan } = validPlan(["p1"]);
  holdNeedsPlanning(needsPlanning(goalId, "x"));
  needsPlanning(goalId, "y", ["x"]);
  moveTaskTo(db, byKey(db, goalId, "y").id, "pending");
  finishPlanner(goalId);
  approveVersion(db, plan.id, 1);
  expect(byKey(db, goalId, "x").status).toBe("cancelled");
  expect(byKey(db, goalId, "y").status).toBe("cancelled");
  const ev = listUndelivered(db, TH).find((e) => e.kind === "plan_revised");
  expect(ev?.payload).toMatchObject({ cancelled: expect.arrayContaining(["x", "y"]) });
});

test("B6: a plan item that waits for the item the approval releases is refused at validation (M2)", () => {
  const { goalId, plan } = validPlan(["p1"]);
  holdNeedsPlanning(needsPlanning(goalId, "x"));
  const revised = revisePlan(db, {
    planId: plan.id,
    baseVersion: 1,
    edit: edit({ add: [item("p2", { dependsOn: ["x"] })] }),
    reason: "after x",
    env: ENV,
  });
  expect(revised).toMatchObject({ ok: false, code: "INVALID" });
  expect(revised.ok === false && revised.message).toContain("RELEASED_DEP");
});

test("B7: Orchestrate cancel of a planner item leaves the goal's pending plan valid; Orchestrate cancel of the goal closes it", () => {
  const { goalId, plan } = validPlan();
  const port = createDbEffectPort({
    db,
    threadId: TH,
    env: { workerRoles: ENV.workerRoles, locations: ENV.locations },
    io: {
      steerTask: () => "none",
      askOwner: async () => ({ timedOut: true }),
      post: async () => {},
    },
  });
  port.cancel(byKey(db, goalId, "planner").id, "stuck");
  expect(getPlan(db, plan.id, 1)?.status).toBe("valid");
  port.cancel(goalId, "stop");
  expect(getPlan(db, plan.id, 1)?.status).toBe("rejected");
});

test("B8: modify of a started item is refused when the base is a pending valid version", () => {
  const { goalId, planId } = approved([item("a"), item("b")]);
  const grown = { ...ENVELOPE, bounds: { maxItems: 8, maxGb: 5 } };
  expect(
    revisePlan(db, {
      planId,
      baseVersion: 1,
      edit: edit({ envelope: grown }),
      reason: "x",
      env: ENV,
    }),
  ).toMatchObject({ ok: true, status: "valid" });
  moveTaskTo(db, byKey(db, goalId, "a").id, "running");
  const r = revisePlan(db, {
    planId,
    baseVersion: 2,
    edit: edit({ modify: [{ key: "a", brief: "new text" }] }),
    reason: "x",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: false, code: "ITEM_STARTED" });
});

test("B9: Orchestrate request_plan is refused while a planner item of the goal is live", () => {
  const caps = { chainCount: 0, dispatchedThisRun: 0 };
  const planner = (status: string) => itemRow({ itemKey: "planner-2", status: status as never });
  const state = (status: string) => ({ openGoalId: "g1", items: [planner(status)] });
  expect(checkPlanRequest(state("running"), { goalId: "g1" }, caps)).toMatchObject({
    ok: false,
    code: "PLANNER_RUNNING",
  });
  expect(checkPlanRequest(state("ready"), { goalId: "g1" }, caps)).toMatchObject({
    code: "PLANNER_RUNNING",
  });
  expect(checkPlanRequest(state("completed"), { goalId: "g1" }, caps)).toEqual({ ok: true });
});

/** A fake runtime for the sweeper: the db and a recorder of announces. */
const rtOf = (announced: string[]) =>
  ({ deps: { db }, announce: (t: string) => announced.push(t) }) as unknown as LeadRuntime;
const later = () => Date.now() + PENDING_PLAN_MAX_AGE_MS + ASK_OWNER_TIMEOUT_MS + 1000;

test("B10: an expired pending plan is rejected, its goal stays open for a re-plan and the lead is told once", () => {
  const { goalId, plan } = validPlan();
  finishPlanner(goalId);
  const announced: string[] = [];
  expect(sweepPendingPlans(rtOf(announced), later())).toBe(1);
  expect(getPlan(db, plan.id, 1)).toMatchObject({ status: "rejected", reason: "expired" });
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
  const ev = listUndelivered(db, TH).filter((e) => e.kind === "timeout");
  expect(ev).toHaveLength(1);
  expect(ev[0]?.payload).toMatchObject({ code: "PLAN_EXPIRED", version: 1 });
  expect(announced).toEqual([TH]);
  expect(sweepPendingPlans(rtOf(announced), later())).toBe(0); // nothing left to expire
});

test("B10: an expired grown revision of an approved plan is rejected; the goal settles from its items", () => {
  const { goalId, planId } = approved([item("a")]);
  const grown = { ...ENVELOPE, bounds: { maxItems: 8, maxGb: 5 } };
  revisePlan(db, {
    planId,
    baseVersion: 1,
    edit: edit({ envelope: grown }),
    reason: "x",
    env: ENV,
  });
  complete(db, goalId, "a");
  complete(db, goalId, "verify-1");
  sweepPendingPlans(rtOf([]), later());
  expect(planVersions(db, planId).map((v) => v.status)).toEqual(["approved", "rejected"]);
  expect(getOwnedTask(db, goalId)?.status).toBe("completed");
});

test("B10/B14: Orchestrate approve_plan is refused before asking when the goal is not the thread's open goal", async () => {
  const { goalId, plan } = validPlan();
  const real = createPlanPort(db, TH);
  expect(real.plan(plan.id, 1)?.blocker).toBeUndefined();
  createPlanPort(db, TH).requestPlan({ key: "k2", objective: "newer goal" }); // a newer open goal
  expect(real.plan(plan.id, 1)?.blocker).toMatchObject({ code: "GOAL_NOT_OPEN" });
  const port = new FakePort();
  port.plan = real.plan;
  const r = await handleApprovePlan(leadCtx(port), { planId: plan.id, version: 1 });
  expect(r).toMatchObject({ ok: false, code: "GOAL_NOT_OPEN" });
  expect(port.asked).toHaveLength(0);
  expect(goalId).toBeTruthy();
});

test("B14: a plan whose budget is spent is refused before the question; a refusal after the click is posted", async () => {
  const { goalId, plan } = validPlan();
  spend(db, byKey(db, goalId, "planner").id, plan.budgetUsd ?? 0); // the goal spent the computed budget
  const real = createPlanPort(db, TH);
  expect(real.plan(plan.id, 1)?.blocker).toMatchObject({ code: "BUDGET" });
  const port = new FakePort();
  port.plans.set("p1:1", view());
  port.answer = { answer: "Approve plan", timedOut: false };
  port.decidePlan = () => ({ ok: false, code: "BUDGET", message: "Budget $3 is spent." });
  const r = await handleApprovePlan(
    { ...leadCtx(port), language: "en" },
    { planId: "p1", version: 1 },
  );
  expect(r).toMatchObject({ ok: false, code: "BUDGET" });
  expect(port.posts[0]?.text).toBe(
    renderUserNotice({ kind: "plan-not-started", cause: "budget" }, "en"),
  );
});

test("B13: a wave goal held at the cap or stalled can be re-planned inside itself, keeping the deferred items", () => {
  const p = approvedPlan([item("a"), item("d", { deferredScope: true })]);
  db = p.db;
  complete(db, p.goalId, "a");
  expect(startNextWave(db, p.goalId)).toBe(true);
  moveTaskTo(db, byKey(db, p.goalId, "planner-2").id, "cancelled"); // the wave planner dies: stalled
  settleGoal(db, p.goalId);
  expect(waveOutlook(db, p.goalId)).toBe("stalled");
  expect(waveHeldGoalOf(db, TH)).toBe(p.goalId);
  const port = createDbEffectPort({
    db,
    threadId: TH,
    env: { workerRoles: ENV.workerRoles, locations: ENV.locations },
    io: {
      steerTask: () => "none",
      askOwner: async () => ({ timedOut: true }),
      post: async () => {},
    },
  });
  const state = port.state();
  expect(state.openGoalId).toBeUndefined();
  expect(state.waveHeldGoalId).toBe(p.goalId);
  const caps = { ...port.caps(), dispatchedThisRun: 0 };
  expect(checkPlanRequest(state, { goalId: p.goalId }, caps)).toEqual({ ok: true });
  const w = port.requestPlan({ key: "k9", objective: "build it", goalId: p.goalId });
  expect(w.ok).toBe(true);
  const planner = byKey(db, p.goalId, "planner-3");
  expect(planner.brief).toContain("d (developer)"); // the deferred item stays visible
  expect(keysOf(db, p.goalId)).toContain("a:completed");
  // The hold texts the lead read tell it how to re-plan: the stalled one came from the settle, the capped one is written here.
  noteWaveHold(db, p.goalId, "capped");
  const held = listUndelivered(db, TH).filter((e) => e.kind === "failure");
  for (const code of ["WAVE_STALLED", "WAVE_CAP"])
    expect(
      JSON.stringify(held.find((e) => (e.payload as { code?: string }).code === code)?.payload),
    ).toContain("Orchestrate request_plan with this goalId re-plans the rest inside the goal");
});
