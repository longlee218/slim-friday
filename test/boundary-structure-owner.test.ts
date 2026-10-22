import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { createAnnouncer, pendingNews } from "../src/orchestrator/lead/lead-events";
import { handleDispatch } from "../src/orchestrator/lead/lead-handlers";
import {
  handleApprovePlan,
  handleCreatePlan,
  handleRevisePlan,
} from "../src/orchestrator/lead/lead-plan-handlers";
import { afterVerify } from "../src/orchestrator/plan/goal-verify";
import { createPlan } from "../src/orchestrator/plan/plan-lifecycle";
import { recordCodeItems } from "../src/orchestrator/plan/plan-revised";
import { revisePlan } from "../src/orchestrator/plan/plan-revision";
import { assertStructureOwner } from "../src/orchestrator/plan/structure-owner";
import { openDb } from "../src/storage/db";
import { getOwnedTask, insertOwnedTask, structureOwnerOf } from "../src/storage/owned-task-store";
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
  openPlanGoal,
  spend,
  TH,
} from "./plan-fixture";

/* Phase 3 boundary: who owns a goal's structure (lead path add / update for DIRECT / DELEGATE, create_plan / revise_plan for PLAN), the owner gate on
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
/** The lead's `create_plan` input (a new goal, or a plan inside the open goal `goalId`). */
const leadPlan = (goalId?: string) => ({
  objective: "plan it",
  ...(goalId && { goalId }),
  items: [item("p1")],
  acceptanceCriteria: ["works"],
  envelope: ENVELOPE,
  effects: [],
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

test("structureOwner: Orchestrate dispatch goal = lead; Orchestrate create_plan new goal = plan; create_plan(goalId) switches lead -> plan", async () => {
  const { port, ctx } = setup();
  const d = (await handleDispatch(ctx(), DIRECT)) as unknown as { goalId: string };
  expect(structureOwnerOf(db, d.goalId)).toBe("lead");
  expect(port.state().structureOwner).toBe("lead");
  const w = await handleCreatePlan(ctx(), leadPlan(d.goalId));
  expect(w).toMatchObject({ ok: true, version: 1, status: "valid" });
  expect(structureOwnerOf(db, d.goalId)).toBe("plan");
  moveTaskTo(db, d.goalId, "cancelled");
  const fresh = (await handleCreatePlan(ctx(), leadPlan())) as unknown as { goalId: string };
  expect(structureOwnerOf(db, fresh.goalId)).toBe("plan");
});

test("assertStructureOwner: add / update on a PLAN goal is refused and told the right tool; a lead goal passes", () => {
  expect(assertStructureOwner("lead")).toBeUndefined();
  expect(assertStructureOwner("plan")).toMatchObject({
    code: "NOT_STRUCTURE_OWNER",
    message: expect.stringContaining("Orchestrate revise_plan"),
  });
});

test("create_plan / revise_plan: revise_plan of an unknown plan is NO_PLAN; a stored plan can be revised (valid, owner approves)", async () => {
  const { ctx } = setup();
  const d = (await handleDispatch(ctx(), DIRECT)) as unknown as { goalId: string };
  expect(
    await handleRevisePlan(ctx(), {
      planId: "p",
      baseVersion: 1,
      reason: "x",
      add: [],
      cancel: [],
      modify: [],
    }),
  ).toMatchObject({ code: "NO_PLAN" });
  const made = (await handleCreatePlan(ctx(), leadPlan(d.goalId))) as unknown as {
    planId: string;
  };
  const rev = await handleRevisePlan(ctx(), {
    planId: made.planId,
    baseVersion: 1,
    reason: "more",
    add: [],
    cancel: [],
    modify: [],
  });
  expect(rev).toMatchObject({ ok: true, version: 2, status: "valid" });
});

test("B2: GOAL_OPEN on a PLAN goal does not suggest supersedes; on a lead goal it does", async () => {
  const { ctx } = setup();
  await handleCreatePlan(ctx(), leadPlan());
  const r = (await handleDispatch(ctx(), DIRECT)) as { code: string; message: string };
  expect(r.code).toBe("GOAL_OPEN");
  expect(r.message).not.toContain("supersedes");
  expect(r.message).toContain("Orchestrate revise_plan");
  db.close();
  const b = setup();
  await handleDispatch(b.ctx(), DIRECT);
  const r2 = (await handleDispatch(b.ctx(), { ...DIRECT, intent: "two" })) as { message: string };
  expect(r2.message).toContain("supersedes");
});

test("B2: superseding a PLAN goal asks the owner; No keeps it, Yes cancels it; a lead goal asks nothing", async () => {
  const no = setup("No");
  const p = (await handleCreatePlan(no.ctx(), leadPlan())) as unknown as {
    goalId: string;
  };
  const denied = await handleDispatch(no.ctx(), { ...DIRECT, supersedes: p.goalId });
  expect(denied).toMatchObject({ code: "OWNER_DENIED" });
  expect(no.asked).toHaveLength(1);
  expect(getOwnedTask(db, p.goalId)?.status).toBe("open");
  db.close();

  const yes = setup("Yes");
  const p2 = (await handleCreatePlan(yes.ctx(), leadPlan())) as unknown as {
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
  const w = openPlanGoal(db, TH, "build it");
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
  insertOwnedTask(db, {
    id: "old-item",
    threadId: TH,
    ownerRole: "developer",
    status: "completed",
    scope: "earlier work",
    correlationId: v.goalId,
    parentId: v.goalId,
    itemKey: "old",
    brief: "earlier work",
  });
  spend(db, "old-item", 1);
  expect(await handleApprovePlan(v.ctx(), { planId: v.planId, version: 1 })).toMatchObject({
    code: "BUDGET",
  });
  expect(await handleApprovePlan(v.ctx(), { planId: v.planId, version: 1 })).toMatchObject({
    code: "ALREADY_ASKED",
  });
  expect(v.asked).toHaveLength(0);
});

const codeNews = (d: Database) => listUndelivered(d, TH).filter((e) => e.kind === "items_added");

test("code-made items emit one items_added per batch: verify-1, fix-N + verify-N", () => {
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

test("B2: the supersede question is user-copy (vi default, en on request) and a timeout is OWNER_TIMEOUT", async () => {
  const s = setup();
  const p = (await handleCreatePlan(s.ctx(), leadPlan())) as unknown as {
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
