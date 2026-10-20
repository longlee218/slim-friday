import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { PLAN_GOAL_BUDGET_MAX_USD } from "../src/config/model-routing";
import {
  GOAL_BUDGET_USD,
  goalBudgetOf,
  goalOverBudget,
  goalRoute,
} from "../src/orchestrator/budget/task-budget";
import { afterVerify } from "../src/orchestrator/plan/goal-verify";
import { createPlanHandler, type PlannerCtx } from "../src/orchestrator/plan/planner-handlers";
import { digestFacts } from "../src/orchestrator/worker/digest-facts";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { listUndelivered } from "../src/storage/thread-event-store";
import { leadHarness, until } from "./lead-harness";
import {
  approvedPlan,
  byKey,
  complete,
  failVerify,
  item,
  newGoal,
  spend,
  TH,
} from "./waves-fixture";

/* The per-goal budget figure: a PLAN goal = its approved plan budget (ceiling $35), a DELEGATE goal = $15. One function
   (`goalBudgetOf`) feeds the dispatch refusal, the goal-left run cap, the verify loop and the digest. */

let db: Database;
afterEach(() => db?.close());

test("goalBudgetOf: no plan = GOAL_BUDGET_USD; approved plan = its budget; never above PLAN_GOAL_BUDGET_MAX_USD", () => {
  const bare = newGoal();
  db = bare.db;
  expect(GOAL_BUDGET_USD).toBe(15);
  expect(goalBudgetOf(db, bare.goalId)).toBe(15);
  const p = approvedPlan([item("a")], { budget: 4 });
  expect(goalBudgetOf(p.db, p.goalId)).toBe(4);
  // A stored value above the ceiling (it cannot pass the validator) is clamped.
  p.db.query("UPDATE work_plans SET budget_usd = 99 WHERE goal_id = ?").run(p.goalId);
  expect(goalBudgetOf(p.db, p.goalId)).toBe(PLAN_GOAL_BUDGET_MAX_USD);
  expect(PLAN_GOAL_BUDGET_MAX_USD).toBe(35);
  p.db.close();
});

test("the validator accepts a plan budget up to the plan ceiling and refuses above it", () => {
  const g = newGoal();
  db = g.db;
  const ctx: PlannerCtx = {
    db,
    threadId: TH,
    goalId: g.goalId,
    workers: dispatchableWorkers(),
    locations: [{ name: "repo", path: "/x" }],
    channelDigest: () => "",
  };
  const input = (budgetUsd: number) => ({
    goalId: g.goalId,
    items: [item("a")],
    acceptanceCriteria: [],
    envelope: { locations: ["repo"], riskClasses: ["R1"], bounds: { maxItems: 2, maxGb: 1 } },
    budgetUsd,
    effects: [],
  });
  expect(createPlanHandler(ctx, input(PLAN_GOAL_BUDGET_MAX_USD + 0.01))).toMatchObject({
    ok: false,
    code: "INVALID",
  });
  expect(createPlanHandler(ctx, input(PLAN_GOAL_BUDGET_MAX_USD))).toMatchObject({ ok: true });
});

test("plan goal: over-budget flag, goal-left cap and digest follow the plan budget; a DELEGATE goal keeps 15", () => {
  const p = approvedPlan([item("a"), item("b", { dependsOn: ["a"] })], { budget: 4 });
  db = p.db;
  const a = byKey(db, p.goalId, "a").id;
  spend(db, a, 3);
  expect(goalOverBudget(db, p.goalId)).toBe(false);
  expect(goalRoute(db, p.goalId).capUsd).toBeCloseTo(1, 6); // 4 - 3, not 15 - 3
  expect(digestFacts(db, p.goalId, "o", Date.now())).toMatchObject({ budgetUsd: 4, spentUsd: 3 });
  spend(db, a, 1, 2);
  expect(goalOverBudget(db, p.goalId)).toBe(true);
  expect(goalRoute(db, p.goalId).capUsd).toBe(0);
  // DELEGATE: no plan row, the general figure.
  const d = newGoal();
  const planner = byKey(d.db, d.goalId, "planner").id;
  spend(d.db, planner, 14);
  expect(goalOverBudget(d.db, d.goalId)).toBe(false);
  expect(goalRoute(d.db, d.goalId).capUsd).toBeCloseTo(1, 6);
  expect(digestFacts(d.db, d.goalId, "o", Date.now()).budgetUsd).toBe(15);
  spend(d.db, planner, 1, 2);
  expect(goalOverBudget(d.db, d.goalId)).toBe(true);
  d.db.close();
});

test("the verify loop reads the plan budget: a goal at its $4 plan budget starts no fix loop", () => {
  const p = approvedPlan([item("a")], { budget: 4 });
  db = p.db;
  complete(db, p.goalId, "a");
  spend(db, byKey(db, p.goalId, "a").id, 4); // far below 15, at the plan budget
  const id = failVerify(db, p.goalId, "verify-1");
  const verdict = { action: "hold", class: "real", cause: "worker_failed", attempt: 0 } as const;
  expect(afterVerify(db, id, verdict)).toBe(false);
  const ev = listUndelivered(db, TH).find((e) => (e.payload as any)?.code === "OVER_BUDGET");
  expect(ev?.payload).toMatchObject({ cause: "budget" });
});

const GOAL = /Goal id: ([0-9a-f-]{36})/;
const PLAN_ID = /"planId":"([0-9a-f-]{36})"/;

test("budget_hit: a plan goal stops starting items at its plan budget ($4), and its run cap is the goal's rest", async () => {
  const caps: Record<string, number> = {};
  const started: string[] = [];
  const h = leadHarness(
    async (c) => {
      if (c.kind === "planner") {
        const goalId = GOAL.exec(c.prompt)?.[1] as string;
        const made = await c.plan("create", {
          goalId,
          items: [
            item("a", { location: "location" }),
            item("b", { dependsOn: ["a"], location: "location" }),
          ],
          acceptanceCriteria: [],
          envelope: {
            locations: ["location"],
            riskClasses: ["R1"],
            bounds: { maxItems: 4, maxGb: 1 },
          },
          budgetUsd: 4,
          effects: [],
        });
        await c.report("result", {
          title: "T",
          status: "COMPLETED",
          summary: `plan ${made.planId}`,
        });
        return "planned";
      }
      if (c.kind === "worker") {
        const key = /do (\w+)/.exec(c.prompt)?.[1] as string;
        started.push(key);
        caps[key] = c.options.maxBudgetUsd;
        await c.report("result", { title: "T", status: "COMPLETED", summary: "done" });
        return { text: "ok", cost: 5 }; // over the whole $4 plan budget
      }
      if (c.prompt.includes("Owner message:")) {
        await c.orchestrate("request_plan", { objective: "two steps" });
        return "Planning.";
      }
      const plan = PLAN_ID.exec(c.prompt)?.[1];
      if (plan && c.prompt.includes("plan"))
        await c.orchestrate("approve_plan", { planId: plan, version: 1 });
      return "";
    },
    undefined,
    { askChoice: async () => "Approve plan" },
  );
  await h.send("two steps");
  const hits = () =>
    h.env.db.query("SELECT payload FROM thread_events WHERE kind = 'budget_hit'").all() as {
      payload: string;
    }[];
  await until(() => hits().length > 0 || started.length > 1, 15000);
  expect(started).toEqual(["a"]); // b was refused
  expect(caps.a).toBeGreaterThan(3.9); // goal-left cap: 4 - the planner's tiny cost, not the developer's $8 or 15
  expect(caps.a).toBeLessThan(4);
  expect(hits()[0]?.payload).toContain("goal budget $4 used");
  const goalId = GOAL.exec(h.calls.find((c) => c.kind === "planner")!.prompt)?.[1] as string;
  // The budget hit HOLDS the item (E-L13): the lead may retry it once the budget allows, or cancel it.
  const b = byKey(h.env.db, goalId, "b");
  expect(b.status).toBe("blocked");
  expect(b.resultKind).toBe("FAILED");
}, 20000);
