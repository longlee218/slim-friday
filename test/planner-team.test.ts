import { expect, test } from "bun:test";
import { PLAN_MAX_CRITERIA } from "../src/config/lead-caps";
import { getAgentCapabilities, type PlannerCtx } from "../src/orchestrator/plan/planner-handlers";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { loadPlannerCases, planMisses } from "./planner-team-support";

/* Planner staffing without an API call: the capabilities the planner sees and the scorer of the paid eval. */

const ctx = (): PlannerCtx => ({
  db: openDb(":memory:"),
  threadId: "th",
  goalId: "g",
  workers: dispatchableWorkers(),
  locations: [],
  channelDigest: () => "",
});

test("capabilities list every dispatchable role with whenToUse, tools and concurrency; no budget", () => {
  const c = ctx();
  const r = getAgentCapabilities(c) as unknown as {
    roles: { name: string; whenToUse: string; capabilities: string[]; concurrency: string }[];
  };
  c.db.close();
  const names = r.roles.map((x) => x.name);
  for (const n of [
    "scout",
    "researcher",
    "solution-architect",
    "designer",
    "developer",
    "tester",
    "devops",
    "humanizer-writer",
    "hacker",
  ])
    expect(names).toContain(n);
  // Not dispatchable: the planner and the control role are not staff.
  expect(names).not.toContain("planner");
  expect(names).not.toContain("lead");
  for (const x of r.roles) {
    expect(x.whenToUse.length).toBeGreaterThan(10);
    expect(Array.isArray(x.capabilities)).toBe(true);
    expect(["limited", "free"]).toContain(x.concurrency);
    expect(x).not.toHaveProperty("budgetUsd");
  }
});

const item = (key: string, role: string) => ({
  key,
  role,
  brief: "b",
  subject: key,
  dependsOn: [],
  risk: "R1" as const,
});
const doc = (roles: string[], criteria = ["c"]) =>
  ({
    items: roles.map((r, i) => item(`i${i}`, r)),
    acceptanceCriteria: criteria,
    envelope: {},
  }) as never;

test("fixture: unique ids, both kinds, a UI project and a non-UI project", () => {
  const cases = loadPlannerCases();
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  expect(cases.some((c) => c.kind === "small")).toBe(true);
  expect(cases.some((c) => c.kind === "project" && c.ui)).toBe(true);
  expect(cases.some((c) => c.kind === "project" && !c.ui)).toBe(true);
});

test("planMisses: team plan passes, thin or padded plans miss", () => {
  const [ui, small] = [
    { id: "a", text: "t", kind: "project", ui: true } as const,
    { id: "b", text: "t", kind: "small", ui: false } as const,
  ];
  expect(planMisses(ui, doc(["solution-architect", "designer", "developer", "tester"]))).toEqual(
    [],
  );
  expect(planMisses(ui, doc(["developer", "tester", "devops"])).join()).toContain("designer");
  expect(planMisses(ui, doc(["developer"])).join()).toContain("distinct roles");
  expect(planMisses(small, doc(["developer"]))).toEqual([]);
  expect(planMisses(small, doc(["developer", "tester", "developer"])).join()).toContain("small");
  expect(planMisses(small, doc(["developer"], [])).join()).toContain("criteria");
  expect(
    planMisses(small, doc(["developer"], Array(PLAN_MAX_CRITERIA + 1).fill("c"))).join(),
  ).toContain("criteria");
});
