import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { MAX_WAVES } from "../src/config/lead-caps";
import {
  ORCHESTRATE_ACTION_REQUEST_PLAN,
  orchestrateRef,
} from "../src/mcp/orchestration/tools/OrchestrateTool/action-names";
import { ORCHESTRATE_TOOL } from "../src/mcp/orchestration/tools/OrchestrateTool/constants";
import { PLAN_TOOL } from "../src/mcp/plan/tools/PlanTool/constants";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { handleApprovePlan } from "../src/orchestrator/lead/lead-plan-handlers";
import { createPlan } from "../src/orchestrator/plan/plan-lifecycle";
import { type PlannerCtx, proposeRevisionHandler } from "../src/orchestrator/plan/planner-handlers";
import { insertPlannerItem } from "../src/orchestrator/plan/planner-item";
import { missingEffects } from "../src/orchestrator/turns/completion";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import { PLANNER_ROLE } from "../src/roles/builtin/planner-role";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { appendEffect, PLAN_ASK_TOOL } from "../src/storage/effect-log-store";
import { childrenOf } from "../src/storage/owned-item-store";
import { getOwnedTask, setStructureOwner } from "../src/storage/owned-task-store";
import { planVersions } from "../src/storage/work-plan-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { ENV, item, TH } from "./waves-fixture";

/* Phase 3 boundary, second half: contract text, tool rows of the table, the guard that needs a real plan, effect-log
   hygiene and the re-plan rows (decisions 15-16; the rest of those are in plan-replan-fixes / plan-lifecycle-fixes). */

let db: Database;
afterEach(() => db?.close());

const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};

/** A PLAN goal (planner-owned) with a valid plan v1; the planner item is done. */
function planGoal() {
  db = openDb(":memory:");
  const w = createPlanPort(db, TH).requestPlan({ key: "k0", objective: "build it" });
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
  for (const i of childrenOf(db, w.goalId)) {
    moveTaskTo(db, i.id, "running");
    moveTaskTo(db, i.id, "completed");
  }
  return { goalId: w.goalId, planId: r.plan.id };
}
const plannerCtx = (goalId: string): PlannerCtx => ({
  db,
  threadId: TH,
  goalId,
  workers: dispatchableWorkers(),
  locations: [{ name: "repo", path: "/x" }],
  channelDigest: () => "",
});

test("Plan revise guard is reachable: a real plan on a lead-owned goal is NOT_STRUCTURE_OWNER", () => {
  const g = planGoal();
  setStructureOwner(db, g.goalId, "lead");
  const r = proposeRevisionHandler(plannerCtx(g.goalId), {
    planId: g.planId,
    baseVersion: 1,
    reason: "x",
    add: [],
    cancel: [],
    modify: [],
  });
  expect(r).toMatchObject({ code: "NOT_STRUCTURE_OWNER" }); // not NO_PLAN: the plan exists
});

test("table rows: planner has the plan tools only, lead has the control tools and no plan write", () => {
  const planner = PLANNER_ROLE.mcpTools ?? [];
  const lead = LEAD_ROLE.mcpTools ?? [];
  // Talk to the owner, start / steer / retry / cancel (the `Orchestrate` actions): lead only.
  expect(planner).not.toContain(ORCHESTRATE_TOOL);
  expect(lead).toContain(ORCHESTRATE_TOOL);
  // Structure of a PLAN goal: planner writes, the lead has no tool for it.
  for (const t of [PLAN_TOOL]) {
    expect(planner).toContain(t);
    expect(lead).not.toContain(t);
  }
});

test("contract text: planner is structure only (revisions are its only way to running items); lead leaves a PLAN goal's items to the planner", async () => {
  const planner = (await PLANNER_ROLE.promptSections?.({} as never))?.join("\n") ?? "";
  expect(planner).toContain("no owner contact");
  expect(planner).toContain("Running items change only through a plan revision.");
  expect(planner).not.toContain("no control of running items");
  const lead = (await LEAD_ROLE.promptSections?.({} as never))?.join("\n") ?? "";
  expect(lead).toContain("A PLAN goal's items belong to the planner");
  expect(lead).toContain("Code adds verify, fix and wave items");
});

test("ALREADY_ASKED tells the lead one next step per outcome", async () => {
  const g = planGoal();
  const port = createDbEffectPort({
    db,
    threadId: TH,
    env: { workerRoles: ["developer"], locations: ["repo"] },
    io: {
      steerTask: () => "none",
      askOwner: async () => ({ timedOut: true }),
      post: async () => {},
    },
  });
  const ctx = { port, threadId: TH, leadTurnId: "lt", inputId: "in", run: { dispatched: 0 } };
  const ask = (n: number) =>
    handleApprovePlan(
      { ...ctx, leadTurnId: `lt${n}`, inputId: `in${n}` },
      { planId: g.planId, version: 1 },
    );
  await ask(1);
  const again = (await ask(2)) as { code: string; message: string };
  expect(again.code).toBe("ALREADY_ASKED");
  expect(again.message).toContain("the owner did not answer: tell them the plan waits");
  // The other two outcomes read their own line.
  const row = (o: string) =>
    db.query("UPDATE effect_log SET result = ? WHERE tool = ?").run(o, PLAN_ASK_TOOL);
  row("UNCLEAR");
  expect(((await ask(3)) as { message: string }).message).toContain(
    `call ${orchestrateRef(ORCHESTRATE_ACTION_REQUEST_PLAN)} with the goalId and their words`,
  );
  row("BUDGET");
  expect(((await ask(4)) as { message: string }).message).toContain("the budget is spent");
});

test("completion: a PlanAsk effect row never counts as a delivery or a missing effect", () => {
  const g = planGoal();
  appendEffect(db, {
    id: "plan-ask:x",
    threadId: TH,
    goalId: g.goalId,
    tool: PLAN_ASK_TOOL,
    scope: "p:1",
    grantedBy: "role",
    result: "TIMEOUT",
  });
  // Expecting a real delivery tool: the PlanAsk row (unreadable result, other tool) is not it.
  expect(missingEffects(db, { goalId: g.goalId, tools: ["GitPush"] })).toEqual(["GitPush"]);
});

test("re-plan keeps the goal open and planner-owned; past MAX_WAVES it is a re-plan, and nothing starts before Orchestrate approve_plan", () => {
  const g = planGoal();
  for (let n = 1; n < MAX_WAVES; n++)
    insertPlannerItem(db, {
      goalId: g.goalId,
      threadId: TH,
      correlationId: g.goalId,
      objective: "o",
      brief: "b",
      eventId: (k) => `extra:${k}`,
      payload: {},
    });
  for (const i of childrenOf(db, g.goalId))
    if (i.status === "pending" || i.status === "ready") moveTaskTo(db, i.id, "cancelled");
  const w = createPlanPort(db, TH).requestPlan({ key: "k9", objective: "again", goalId: g.goalId });
  expect(w).toMatchObject({ ok: true, goalId: g.goalId });
  expect(getOwnedTask(db, g.goalId)?.status).toBe("open");
  expect(planVersions(db, g.planId).map((p) => p.status)).toEqual(["valid"]); // the owner has not approved anything
  expect(childrenOf(db, g.goalId).some((i) => i.itemKey === "p1")).toBe(false); // plan items are not created before approval
});
