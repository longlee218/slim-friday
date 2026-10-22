import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  ORCHESTRATE_ACTION_REVISE_PLAN,
  orchestrateRef,
} from "../src/mcp/orchestration/tools/OrchestrateTool/action-names";
import { ORCHESTRATE_TOOL } from "../src/mcp/orchestration/tools/OrchestrateTool/constants";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { handleApprovePlan } from "../src/orchestrator/lead/lead-plan-handlers";
import { createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { missingEffects } from "../src/orchestrator/turns/completion";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import { findRole } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { appendEffect, PLAN_ASK_TOOL } from "../src/storage/effect-log-store";
import { childrenOf } from "../src/storage/owned-item-store";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { planVersions } from "../src/storage/work-plan-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { ENV, item, openPlanGoal, TH } from "./plan-fixture";

/* Phase 3 boundary, second half: contract text, tool rows of the table, the guard that needs a real plan, effect-log
   hygiene and the re-plan rows (decisions 15-16; the rest of those are in plan-replan-fixes / plan-lifecycle-fixes). */

let db: Database;
afterEach(() => db?.close());

const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};

/** A PLAN goal with a valid plan v1 (no item yet). */
function planGoal() {
  db = openDb(":memory:");
  const w = openPlanGoal(db, TH, "build it");
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
  return { goalId: w.goalId, planId: r.plan.id };
}
test("table rows: the lead has the control tools; there is no planner role", () => {
  const lead = LEAD_ROLE.mcpTools ?? [];
  // Talk to the owner, start / steer / retry / cancel, write and revise the plan (the `Orchestrate` actions): lead only.
  expect(lead).toContain(ORCHESTRATE_TOOL);
  expect(findRole("planner")).toBeUndefined();
});

test("contract text: the lead writes the plan; a PLAN goal's items change only through create_plan / revise_plan", async () => {
  const lead = (await LEAD_ROLE.promptSections?.({} as never))?.join("\n") ?? "";
  expect(lead).toContain(
    "PLAN goals: you write the plan (create_plan, revise_plan); add or update on its items is refused",
  );
  expect(lead).toContain("code adds verify and fix items");
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
    `call ${orchestrateRef(ORCHESTRATE_ACTION_REVISE_PLAN)}`,
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

test("re-plan after a reject keeps the goal open and plan-owned, and nothing starts before Orchestrate approve_plan", () => {
  const g = planGoal();
  rejectVersion(db, g.planId, 1, "no");
  const w = createPlanPort(db, TH, undefined, () => ENV).createPlan({
    objective: "again",
    goalId: g.goalId,
    items: [item("p2")],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    effects: [],
    confirmNew: true,
  });
  expect(w).toMatchObject({ ok: true, goalId: g.goalId, version: 2 });
  expect(getOwnedTask(db, g.goalId)?.status).toBe("open");
  expect(planVersions(db, g.planId).map((p) => p.status)).toEqual(["rejected", "valid"]); // the owner has not approved anything
  expect(childrenOf(db, g.goalId).some((i) => i.itemKey === "p2")).toBe(false); // plan items are not created before approval
});
