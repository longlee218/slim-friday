import { expect, test } from "bun:test";
import { PLAN_BUDGET_RESERVE_FACTOR, PLAN_GOAL_BUDGET_MAX_USD } from "../src/config/model-routing";
import { planBudgetUsd } from "../src/orchestrator/budget/plan-budget";
import { ROLES } from "../src/roles/role-registry";

/* The code-computed plan budget: role ceilings summed, one tester verify run per writer location, times the reserve
   factor, rounded up, capped. The planner never sets it. */

const dev = ROLES.developer!.budgetUsd as number;
const scout = ROLES.scout!.budgetUsd as number;
const tester = ROLES.tester!.budgetUsd as number;
const budget = (
  items: { role: string; location?: string; deferredScope?: boolean }[],
  verifies = true,
  spentUsd = 0,
) => planBudgetUsd({ items, verifies, spentUsd });

test("the role figures the expectations below rely on", () => {
  expect([dev, scout, tester, PLAN_BUDGET_RESERVE_FACTOR, PLAN_GOAL_BUDGET_MAX_USD]).toEqual([
    8, 1.5, 4, 1.25, 35,
  ]);
});

test("sum of the items' role ceilings times the reserve factor, rounded up to a whole dollar", () => {
  expect(budget([{ role: "scout" }])).toBe(2); // 1.5 * 1.25 = 1.875 -> 2 (no location: no writer, no verify)
  expect(budget([{ role: "scout" }, { role: "scout" }, { role: "scout" }])).toBe(6); // 5.625 -> 6
  expect(budget([{ role: "developer" }], false)).toBe(10); // 8 * 1.25
});

test("one tester verify run per location with a writer item, only when the plan has criteria", () => {
  const oneLoc = [
    { role: "developer", location: "repo" },
    { role: "developer", location: "repo" },
  ];
  expect(budget(oneLoc)).toBe(25); // (16 + 4) * 1.25
  expect(budget(oneLoc, false)).toBe(20); // no criteria: no verify run
  // Two writer locations: two verify runs. A scout or a tester item in a location is not a writer.
  expect(
    budget([
      { role: "developer", location: "repo" },
      { role: "developer", location: "docs" },
      { role: "scout", location: "web" },
    ]),
  ).toBe(32); // (8 + 8 + 1.5 + 4 + 4) * 1.25 = 31.875 -> 32
});

test("deferred-scope items count (a wave that activates them keeps the budget); cancelled items have left the version", () => {
  const active = { role: "developer", location: "repo" };
  const deferred = { role: "developer", location: "repo", deferredScope: true };
  expect(budget([active, deferred])).toBe(budget([active, { ...deferred, deferredScope: false }]));
  // A cancel removes the item from the version: the budget of what is left.
  expect(budget([active])).toBe(15); // (8 + 4) * 1.25
});

test("capped at the plan goal ceiling, never refused for size", () => {
  const many = Array.from({ length: 6 }, () => ({ role: "developer", location: "repo" }));
  expect(budget(many)).toBe(PLAN_GOAL_BUDGET_MAX_USD);
});

test("not above what the goal spent: the spend is added on top (capped); at the ceiling it stays the ceiling", () => {
  const one = [{ role: "developer" }];
  expect(budget(one, false, 4)).toBe(10); // own budget is above the spend
  expect(budget(one, false, 10)).toBe(20); // ceil(10 + 10)
  expect(budget(one, false, 30)).toBe(PLAN_GOAL_BUDGET_MAX_USD); // the validator then refuses it (spent >= budget)
});

test("an unknown role counts 0 (the validator refuses the role)", () => {
  expect(budget([{ role: "nope" }, { role: "scout" }])).toBe(2);
});
