import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { PLAN_DOC_MAX_CHARS } from "../src/orchestrator/lead/lead-limits";
import { ensureBriefMessage } from "../src/orchestrator/messages/brief-message";
import { boardGet } from "../src/orchestrator/messages/task-board-reads";
import { syncPlanArtifacts } from "../src/orchestrator/plan/plan-artifact";
import { approveVersion, createPlan } from "../src/orchestrator/plan/plan-lifecycle";
import { revisePlan } from "../src/orchestrator/plan/plan-revision";
import {
  CREATE_LEAD_PLAN_SHAPE,
  PROPOSE_REVISION_SHAPE,
} from "../src/orchestrator/plan/plan-schemas";
import { listByGoal } from "../src/storage/artifact-store";
import { openDb } from "../src/storage/db";
import { childrenOf } from "../src/storage/owned-item-store";
import { listTaskMessages } from "../src/storage/task-message-store";
import { recordBotThread } from "../src/storage/thread-store";
import { getPlan } from "../src/storage/work-plan-store";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { ENV, item, openPlanGoal, setStoredBudget, TH } from "./plan-fixture";

/* Spec and plan text of a plan: required on create, kept or replaced by a revision, sections in item briefs, shown in the plan view. */

const SPEC = "# Spec\nBuild a login page.";
const PLAN =
  "# Plan\n## Login\nUse the form lib.\n### Notes\nkeep it small\n## Logout\nclear cookie";
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};
let db: Database;
afterEach(() => db?.close());

/** A goal with plan v1 (valid) holding the spec and plan text. */
function setup(items = [item("a", { section: "Login" })], spec = SPEC, plan = PLAN) {
  db = openDb(":memory:");
  const w = openPlanGoal(db, TH, "build it");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items,
    acceptanceCriteria: [],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
    spec,
    plan,
  });
  if (!r.ok) throw new Error(r.message);
  return { goalId: w.goalId, planId: r.plan.id };
}

test("create_plan needs spec and plan; revise_plan may omit them", () => {
  const create = z.object(CREATE_LEAD_PLAN_SHAPE);
  const base = {
    objective: "o",
    items: [{ ...item("a") }],
    acceptanceCriteria: [],
    envelope: ENVELOPE,
    effects: [],
  };
  expect(create.safeParse(base).success).toBe(false);
  expect(create.safeParse({ ...base, spec: "s" }).success).toBe(false);
  expect(create.safeParse({ ...base, spec: "s", plan: "p" }).success).toBe(true);
  expect(
    create.safeParse({ ...base, spec: "s", plan: "x".repeat(PLAN_DOC_MAX_CHARS + 1) }).success,
  ).toBe(false);
  const rev = z.object(PROPOSE_REVISION_SHAPE);
  expect(rev.safeParse({ planId: "p", baseVersion: 1, reason: "r" }).success).toBe(true);
});

test("create stores spec and plan once; revise keeps them, or replaces them when given", () => {
  const { planId } = setup();
  const v1 = getPlan(db, planId, 1)!;
  expect([v1.specMd, v1.planMd]).toEqual([SPEC, PLAN]);
  const edit = { add: [], cancel: [], modify: [] };
  const r2 = revisePlan(db, { planId, baseVersion: 1, edit, reason: "r", env: ENV });
  if (!r2.ok) throw new Error(r2.message);
  const v2 = getPlan(db, planId, 2)!;
  expect([v2.specMd, v2.planMd]).toEqual([SPEC, PLAN]);
  const r3 = revisePlan(db, {
    planId,
    baseVersion: 2,
    edit: { ...edit, spec: "# Spec\nnew", plan: "# Plan\n## Login\nnew text" },
    reason: "r",
    env: ENV,
  });
  if (!r3.ok) throw new Error(r3.message);
  const v3 = getPlan(db, planId, 3)!;
  expect([v3.specMd, v3.planMd]).toEqual(["# Spec\nnew", "# Plan\n## Login\nnew text"]);
});

test("an item section that is not a heading of the plan is BAD_SECTION and names the headings", () => {
  db = openDb(":memory:");
  const w = openPlanGoal(db, TH, "build it");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "o",
    items: [item("a", { section: "Missing" })],
    acceptanceCriteria: [],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
    spec: SPEC,
    plan: PLAN,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.code).toBe("INVALID");
  expect(r.message).toContain("BAD_SECTION");
  expect(r.message).toContain("Login");
});

test("a revision that drops the heading an item names is refused", () => {
  const { planId } = setup();
  const r = revisePlan(db, {
    planId,
    baseVersion: 1,
    edit: { add: [], cancel: [], modify: [], plan: "# Plan\n## Other\nx" },
    reason: "r",
    env: ENV,
  });
  expect(r.ok).toBe(false);
});

test("an approved item starts with a brief holding its section text and the spec/plan pointer", () => {
  const { goalId, planId } = setup([item("a", { section: "Login" }), item("b")]);
  expect(approveVersion(db, planId, 1).ok).toBe(true);
  const [a, b] = ["a", "b"].map((k) => childrenOf(db, goalId).find((i) => i.itemKey === k)!);
  ensureBriefMessage(db, a!);
  ensureBriefMessage(db, b!);
  const textA = listTaskMessages(db, a!.id)[0]!.text;
  expect(textA).toContain("do a");
  expect(textA).toContain('Plan section "Login" (data):');
  expect(textA).toContain("Use the form lib.");
  expect(textA).toContain("keep it small"); // sub-heading stays inside
  expect(textA).not.toContain("clear cookie");
  expect(textA).toContain(`TaskBoard get {task: "${goalId}", doc: "spec"|"plan"}`);
  // An item without a section still gets the pointer, never a section block.
  const textB = listTaskMessages(db, b!.id)[0]!.text;
  expect(textB).not.toContain("Plan section");
  expect(textB).toContain("doc: ");
  // Starting again with the same text writes nothing.
  expect(ensureBriefMessage(db, a!)).toBeUndefined();
});

test("TaskBoard get doc pages the spec or the plan of a goal", () => {
  const { goalId } = setup(undefined, "S".repeat(9000), PLAN);
  const r = boardGet(db, TH, goalId, undefined, "spec") as Record<string, unknown>;
  expect(r.ok).toBe(true);
  expect((r.text as string).length).toBe(8000);
  expect(r.nextOffset).toBe(8000);
  const r2 = boardGet(db, TH, goalId, undefined, "spec", 8000) as Record<string, unknown>;
  expect((r2.text as string).length).toBe(1000);
  expect(r2.nextOffset).toBeNull();
  const p = boardGet(db, TH, goalId, undefined, "plan") as Record<string, unknown>;
  expect(p.text).toBe(PLAN);
});

test("the plan artifact renders the spec and the plan text", () => {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  const w = openPlanGoal(db, TH, "build it");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items: [item("a")],
    acceptanceCriteria: [],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
    spec: SPEC,
    plan: PLAN,
  });
  if (!r.ok) throw new Error(r.message);
  setStoredBudget(db, r.plan.id, 1, 35);
  syncPlanArtifacts({ db, home: env.home }, TH, w.goalId);
  const body = readFileSync(listByGoal(db, w.goalId)[0]!.path, "utf8");
  expect(body).toContain("## Spec");
  expect(body).toContain("Build a login page.");
  expect(body).toContain("## Plan");
  expect(body).toContain("Use the form lib.");
});
