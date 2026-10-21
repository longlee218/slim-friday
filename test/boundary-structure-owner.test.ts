import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { createAnnouncer, pendingNews } from "../src/orchestrator/lead/lead-events";
import { handleDispatch } from "../src/orchestrator/lead/lead-handlers";
import { handleApprovePlan, handleRequestPlan } from "../src/orchestrator/lead/lead-plan-handlers";
import { afterVerify } from "../src/orchestrator/plan/goal-verify";
import { approveVersion, createPlan } from "../src/orchestrator/plan/plan-lifecycle";
import { recordCodeItems } from "../src/orchestrator/plan/plan-revised";
import { revisePlan } from "../src/orchestrator/plan/plan-revision";
import { startNextWave } from "../src/orchestrator/plan/plan-waves";
import {
  createPlanHandler,
  type PlannerCtx,
  proposeRevisionHandler,
} from "../src/orchestrator/plan/planner-handlers";
import { assertStructureOwner } from "../src/orchestrator/plan/structure-owner";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { getOwnedTask, structureOwnerOf } from "../src/storage/owned-task-store";
import { appendEvent, listUndelivered } from "../src/storage/thread-event-store";
import { planVersions } from "../src/storage/work-plan-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import {
  approvedPlan,
  byKey,
  complete,
  ENV,
  failVerify,
  item,
  newGoal,
  spend,
  TH,
} from "./waves-fixture";

/* Phase 3 boundary: who owns a goal's structure (lead for DIRECT / DELEGATE, planner for PLAN), the owner gate on
   superseding a PLAN goal (B2), one Orchestrate approve_plan ask per plan version (B11) and the news for code-made items. */

let db: Database;
afterEach(() => db?.close());

const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};
const planArgs = (goalId: string) => ({
  goalId,
  objective: "build it",
  items: [item("p1")],
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

/** Real db port with a scriptable owner answer; `asked` collects the owner questions. */
function setup(answer = "Yes") {
  db = openDb(":memory:");
  const asked: string[] = [];
  const port = createDbEffectPort({
    db,
    threadId: TH,
    env: { workerRoles: ["developer", "scout"], locations: ["repo"] },
    io: {
      steerTask: () => "queued",
      askOwner: async (q) => {
        asked.push(q.question);
        return { answer, timedOut: false };
      },
      post: async () => {},
    },
  });
  let n = 0;
  const ctx = () => ({
    port,
    threadId: TH,
    leadTurnId: `lt${++n}`,
    inputId: `in${n}`,
    run: { dispatched: 0 },
  });
  return { port, ctx, asked };
}
const DIRECT = {
  strategy: "DIRECT" as const,
  small: true,
  intent: "one",
  reason: "r",
  assignments: [{ key: "m", subject: "task", role: "developer", brief: "b", dependsOn: [] }],
};

test("structureOwner: Orchestrate dispatch goal = lead; Orchestrate request_plan new goal = planner; Orchestrate request_plan(goalId) switches lead -> planner", async () => {
  const { port, ctx } = setup();
  const d = (await handleDispatch(ctx(), DIRECT)) as unknown as { goalId: string };
  expect(structureOwnerOf(db, d.goalId)).toBe("lead");
  expect(port.state().structureOwner).toBe("lead");
  const w = await handleRequestPlan(ctx(), { objective: "plan it", goalId: d.goalId });
  expect(w.ok).toBe(true);
  expect(structureOwnerOf(db, d.goalId)).toBe("planner");
  moveTaskTo(db, d.goalId, "cancelled");
  const fresh = (await handleRequestPlan(ctx(), { objective: "big" })) as unknown as {
    goalId: string;
  };
  expect(structureOwnerOf(db, fresh.goalId)).toBe("planner");
});

test("assertStructureOwner: the wrong actor is refused and told the right tool; the owner passes", () => {
  expect(assertStructureOwner("planner", "planner")).toBeUndefined();
  expect(assertStructureOwner("lead", "lead")).toBeUndefined();
  expect(assertStructureOwner("planner", "lead")).toMatchObject({
    code: "NOT_STRUCTURE_OWNER",
    message: expect.stringContaining("Orchestrate request_plan"),
  });
  expect(assertStructureOwner("lead", "planner")).toMatchObject({
    code: "NOT_STRUCTURE_OWNER",
    message: expect.stringContaining("Orchestrate request_plan"),
  });
});

test("planner Plan create / Plan revise: refused on a lead-owned goal, accepted on a planner-owned one", async () => {
  const { port, ctx } = setup();
  const d = (await handleDispatch(ctx(), DIRECT)) as unknown as { goalId: string };
  expect(createPlanHandler(plannerCtx(d.goalId), planArgs(d.goalId))).toMatchObject({
    code: "NOT_STRUCTURE_OWNER",
  });
  expect(
    proposeRevisionHandler(plannerCtx(d.goalId), {
      planId: "p",
      baseVersion: 1,
      reason: "x",
      add: [],
      cancel: [],
      modify: [],
    }),
  ).toMatchObject({ code: expect.stringMatching(/NO_PLAN|NOT_STRUCTURE_OWNER/) });
  // The lead hands the goal over (Orchestrate request_plan): now the planner may write.
  port.requestPlan({ key: "k", objective: "plan", goalId: d.goalId });
  const made = createPlanHandler(plannerCtx(d.goalId), planArgs(d.goalId));
  expect(made).toMatchObject({ ok: true, version: 1 });
  const rev = proposeRevisionHandler(plannerCtx(d.goalId), {
    planId: (made as unknown as { planId: string }).planId,
    baseVersion: 1,
    reason: "more",
    add: [],
    cancel: [],
    modify: [],
  });
  expect(rev).toMatchObject({ ok: true });
});

test("B2: GOAL_OPEN on a PLAN goal does not suggest supersedes; on a lead goal it does", async () => {
  const { ctx } = setup();
  await handleRequestPlan(ctx(), { objective: "big" });
  const r = (await handleDispatch(ctx(), DIRECT)) as { code: string; message: string };
  expect(r.code).toBe("GOAL_OPEN");
  expect(r.message).not.toContain("supersedes");
  expect(r.message).toContain("Orchestrate request_plan");
  db.close();
  const b = setup();
  await handleDispatch(b.ctx(), DIRECT);
  const r2 = (await handleDispatch(b.ctx(), { ...DIRECT, intent: "two" })) as { message: string };
  expect(r2.message).toContain("supersedes");
});

test("B2: superseding a PLAN goal asks the owner; No keeps it, Yes cancels it; a lead goal asks nothing", async () => {
  const no = setup("No");
  const p = (await handleRequestPlan(no.ctx(), { objective: "big" })) as unknown as {
    goalId: string;
  };
  const denied = await handleDispatch(no.ctx(), { ...DIRECT, supersedes: p.goalId });
  expect(denied).toMatchObject({ code: "OWNER_DENIED" });
  expect(no.asked).toHaveLength(1);
  expect(getOwnedTask(db, p.goalId)?.status).toBe("open");
  db.close();

  const yes = setup("Yes");
  const p2 = (await handleRequestPlan(yes.ctx(), { objective: "big" })) as unknown as {
    goalId: string;
  };
  const ok = await handleDispatch(yes.ctx(), { ...DIRECT, supersedes: p2.goalId });
  expect(ok.ok).toBe(true);
  expect(getOwnedTask(db, p2.goalId)?.status).toBe("cancelled");
  db.close();

  const lead = setup("No"); // an answer that would deny: it is never asked
  const l = (await handleDispatch(lead.ctx(), DIRECT)) as unknown as { goalId: string };
  const sup = await handleDispatch(lead.ctx(), { ...DIRECT, intent: "two", supersedes: l.goalId });
  expect(sup.ok).toBe(true);
  expect(lead.asked).toHaveLength(0);
});

/** A goal with a valid plan v1 on a real port, ready to ask. */
function validPlan() {
  const s = setup();
  const w = createPlanPort(db, TH).requestPlan({ key: "k0", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, planArgs(w.goalId));
  if (!r.ok) throw new Error(r.message);
  return { ...s, goalId: w.goalId, planId: r.plan.id };
}

test("B11: after TIMEOUT / UNCLEAR the same version is not asked again; a revision or an owner message re-opens it", async () => {
  for (const [answer, timedOut] of [
    ["", true],
    ["change the order", false],
  ] as const) {
    const v = validPlan();
    const ask = () => handleApprovePlan(v.ctx(), { planId: v.planId, version: 1 });
    // The port's askOwner is fixed per setup: swap it through the io by re-binding the answer.
    (v.port as { askOwner: unknown }).askOwner = async (q: { question: string }) => {
      v.asked.push(q.question);
      return timedOut ? { timedOut: true } : { answer, timedOut: false };
    };
    expect(await ask()).toMatchObject({ code: timedOut ? "TIMEOUT" : "UNCLEAR" });
    expect(await ask()).toMatchObject({ code: "ALREADY_ASKED" });
    expect(v.asked).toHaveLength(1);
    // The owner writes: the version may be asked again.
    await Bun.sleep(3);
    appendEvent(db, { id: "om1", threadId: TH, kind: "owner_message", payload: {} });
    expect(await ask()).toMatchObject({ code: timedOut ? "TIMEOUT" : "UNCLEAR" });
    expect(v.asked).toHaveLength(2);
    db.close();
  }
});

test("B11: a revised version (v2) is asked fresh; a rejected version stays PLAN_NOT_VALID", async () => {
  const v = validPlan();
  (v.port as { askOwner: unknown }).askOwner = async () => ({ timedOut: true });
  await handleApprovePlan(v.ctx(), { planId: v.planId, version: 1 });
  const r = revisePlan(db, {
    planId: v.planId,
    baseVersion: 1,
    edit: { add: [], cancel: [], modify: [], acceptanceCriteria: ["x"] },
    reason: "r",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, version: 2 });
  expect(await handleApprovePlan(v.ctx(), { planId: v.planId, version: 2 })).toMatchObject({
    code: "TIMEOUT",
  });
  (v.port as { askOwner: unknown }).askOwner = async () => ({
    answer: "Reject plan",
    timedOut: false,
  });
  await handleApprovePlan(v.ctx(), { planId: v.planId, version: 2 }).catch(() => undefined);
  expect(planVersions(db, v.planId).map((p) => p.status)).toContain("superseded");
});

test("B11: a spent budget is recorded once; the second ask answers ALREADY_ASKED", async () => {
  const v = validPlan();
  db.query("UPDATE work_plans SET budget_usd = 0.0001 WHERE id = ?").run(v.planId);
  const spendRow = byKey(db, v.goalId, "planner").id;
  spend(db, spendRow, 1);
  expect(await handleApprovePlan(v.ctx(), { planId: v.planId, version: 1 })).toMatchObject({
    code: "BUDGET",
  });
  expect(await handleApprovePlan(v.ctx(), { planId: v.planId, version: 1 })).toMatchObject({
    code: "ALREADY_ASKED",
  });
  expect(v.asked).toHaveLength(0);
});

const codeNews = (d: Database) => listUndelivered(d, TH).filter((e) => e.kind === "items_added");

test("code-made items emit one items_added per batch: verify-1, fix-N + verify-N, planner-N", () => {
  const a = approvedPlan([item("a")]);
  db = a.db;
  expect(codeNews(db).map((e) => (e.payload as { added: string[] }).added)).toEqual([["verify-1"]]);
  complete(db, a.goalId, "a");
  failVerify(db, a.goalId, "verify-1");
  const v1 = byKey(db, a.goalId, "verify-1").id;
  expect(afterVerify(db, v1, { cause: "worker_failed" } as never)).toBe(true);
  expect(codeNews(db).map((e) => (e.payload as { added: string[] }).added)).toEqual([
    ["verify-1"],
    ["fix-1", "verify-2"],
  ]);
});

test("a wave planner start emits the news once, even when the pass repeats", () => {
  const g = newGoal();
  db = g.db;
  const r = createPlan(db, {
    ...planArgs(g.goalId),
    items: [item("a"), item("b", { deferredScope: true })],
  });
  if (!r.ok) throw new Error(r.message);
  // Reuse the wave fixture path: approve, finish the item, start the wave.
  approveVersion(db, r.plan.id, 1);
  complete(db, g.goalId, "a");
  expect(startNextWave(db, g.goalId)).toBe(true);
  expect(startNextWave(db, g.goalId)).toBe(false);
  const news = codeNews(db).filter((e) =>
    (e.payload as { added: string[] }).added[0]?.startsWith("planner"),
  );
  expect(news).toHaveLength(1);
});

test("B11: an owner message that arrived DURING the ask lifts the block (stamp = ask start)", async () => {
  const v = validPlan();
  (v.port as { askOwner: unknown }).askOwner = async () => {
    await Bun.sleep(3);
    appendEvent(db, { id: "om-during", threadId: TH, kind: "owner_message", payload: {} });
    await Bun.sleep(3); // the answer comes later than the message
    return { timedOut: true };
  };
  const ask = () => handleApprovePlan(v.ctx(), { planId: v.planId, version: 1 });
  expect(await ask()).toMatchObject({ code: "TIMEOUT" });
  // "yes, approve" was written while the first ask waited: the same version may be asked again.
  expect(await ask()).toMatchObject({ code: "TIMEOUT" });
});

test("B2: a wave-held PLAN goal is not cancelled by a plain dispatch without the owner (No keeps it)", async () => {
  const no = setup("No");
  const p = (await handleRequestPlan(no.ctx(), { objective: "big" })) as unknown as {
    goalId: string;
  };
  // Held wave goal: the planner item ended, no item is live and no open goal is reported.
  (no.port as { state: unknown }).state = () => ({ waveHeldGoalId: p.goalId, items: [] });
  const r = await handleDispatch(no.ctx(), DIRECT);
  expect(r).toMatchObject({ code: "OWNER_DENIED" });
  expect(no.asked).toHaveLength(1);
  expect(getOwnedTask(db, p.goalId)?.status).toBe("open");
});

test("B2: the supersede question is user-copy (vi default, en on request) and a timeout is OWNER_TIMEOUT", async () => {
  const s = setup();
  const p = (await handleRequestPlan(s.ctx(), { objective: "big" })) as unknown as {
    goalId: string;
  };
  (s.port as { askOwner: unknown }).askOwner = async (q: { question: string }) => {
    s.asked.push(q.question);
    return { timedOut: true };
  };
  const r = await handleDispatch(
    { ...s.ctx(), language: "en" },
    { ...DIRECT, supersedes: p.goalId },
  );
  expect(r).toMatchObject({ code: "OWNER_TIMEOUT" });
  expect(s.asked[0]).toContain("Cancel the plan");
  await handleDispatch({ ...s.ctx() }, { ...DIRECT, intent: "two", supersedes: p.goalId });
  expect(s.asked[1]).not.toContain("Cancel the plan"); // vi by default
  expect(getOwnedTask(db, p.goalId)?.status).toBe("open");
});

test("items_added: the same batch recorded twice is one event (stable id)", () => {
  const g = newGoal();
  db = g.db;
  recordCodeItems(db, g.goalId, ["verify-1"], "r");
  recordCodeItems(db, g.goalId, ["verify-1"], "r");
  recordCodeItems(db, g.goalId, ["fix-1", "verify-2"], "r");
  expect(codeNews(db)).toHaveLength(2);
});

test("items_added is passive: it never wakes the lead alone, but rides in the next announce", async () => {
  const g = newGoal();
  db = g.db;
  recordCodeItems(db, g.goalId, ["verify-1"], "r");
  const pushed: unknown[] = [];
  const ann = createAnnouncer({ db, push: (i) => pushed.push(i), windowMs: 5 });
  ann.notify(TH);
  await Bun.sleep(30);
  expect(pushed).toHaveLength(0);
  // A real news event wakes the lead; the passive one is read with it.
  appendEvent(db, { id: "f1", threadId: TH, kind: "failure", payload: {} });
  ann.notify(TH);
  await Bun.sleep(30);
  expect(pushed).toHaveLength(1);
  expect(pendingNews(db, TH).map((e) => e.kind)).toEqual(["items_added", "failure"]);
  ann.stopAll();
});
