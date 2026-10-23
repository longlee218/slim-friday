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
import { digestFacts } from "../src/orchestrator/worker/digest-facts";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import {
  approvedPlan,
  byKey,
  complete,
  failVerify,
  item,
  newGoal,
  spend,
  TH,
} from "./plan-fixture";
import { createPlanFor, plannerCtxOf } from "./plan-visibility-helpers";
import { teammateHarness, until } from "./teammate-harness";

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

test("create_plan: code computes the budget from the items' role ceilings, capped at the plan ceiling", () => {
  const g = newGoal();
  db = g.db;
  const app = plannerCtxOf({ db }, g.goalId);
  const budget = (keys: string[]) => {
    const r = createPlanFor(app, {
      spec: "# Spec",
      plan: "# Plan",
      items: keys.map((k) => item(k)),
      acceptanceCriteria: ["tests pass"],
      envelope: { locations: ["repo"], riskClasses: ["R1"], bounds: { maxItems: 8, maxGb: 1 } },
      effects: [],
    });
    const planId = (r as unknown as { planId: string }).planId;
    const stored = db.query("SELECT budget_usd AS b FROM work_plans WHERE id = ?").get(planId);
    db.query("DELETE FROM work_plans WHERE id = ?").run(planId); // the next call creates a fresh plan
    return (stored as { b: number }).b;
  };
  // Two developer runs ($8 each) + one verify run ($4, tester) in repo, times 1.25.
  expect(budget(["a", "b"])).toBe(25);
  // Five developer runs: (40 + 4) * 1.25 = 55, capped.
  expect(budget(["a", "b", "c", "d", "e"])).toBe(PLAN_GOAL_BUDGET_MAX_USD);
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
  const planner = crypto.randomUUID(); // a bare run of the goal: no plan row
  insertOwnedTask(d.db, {
    id: planner,
    threadId: TH,
    ownerRole: "developer",
    status: "completed",
    scope: "x",
    correlationId: d.goalId,
    parentId: d.goalId,
    itemKey: "solo",
  });
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

test("budget_hit: a plan goal stops starting items at its computed plan budget ($20)", async () => {
  const caps: Record<string, number> = {};
  const started: string[] = [];
  let goalIdSeen = "";
  const h = teammateHarness(
    async (c) => {
      if (c.kind === "worker") {
        const key = /do (\w+)/.exec(c.prompt)?.[1] as string;
        started.push(key);
        caps[key] = c.options.maxBudgetUsd;
        await c.report("result", { title: "T", status: "COMPLETED", summary: "done" });
        return { text: "ok", cost: 25 }; // over the whole $20 plan budget (2 developer runs * $8 * 1.25)
      }
      if (c.prompt.includes("<owner_message>")) {
        const made = await c.orchestrate("create_plan", {
          objective: "two steps",
          spec: "# Spec\nThe goal.",
          plan: "# Plan\nThe steps.",
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
          effects: [],
        });
        goalIdSeen = made.goalId;
        await c.orchestrate("approve_plan", { planId: made.planId, version: 1 });
        return "Planning.";
      }
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
  expect(caps.a).toBeCloseTo(8, 6); // the developer's own ceiling: the goal still had ~$20 left
  expect(hits()[0]?.payload).toContain("goal budget $20 used");
  const goalId = goalIdSeen;
  // The budget hit HOLDS the item (E-L13): the teammate may retry it once the budget allows, or cancel it.
  const b = byKey(h.env.db, goalId, "b");
  expect(b.status).toBe("blocked");
  expect(b.resultKind).toBe("FAILED");
}, 20000);
