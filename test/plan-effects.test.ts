import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { CREATE_PULL_REQUEST_TOOL } from "../src/mcp/effects/tools/CreatePullRequestTool/constants";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { approveVersion, createPlan } from "../src/orchestrator/plan/plan-lifecycle";
import { CREATE_PLAN_SHAPE } from "../src/orchestrator/plan/plan-schemas";
import { loadEnvelope } from "../src/policy/load-envelope";
import { openDb } from "../src/storage/db";

/* A plan's `effects` list is the envelope's delivery grants: stored, approved, loaded back at a worker start. */

let db: Database;
afterEach(() => db?.close());
const ENV = { workerRoles: ["developer"], locations: ["repo"], goalBudgetUsd: 6 };
const plan = (effects: ("GitPush" | "CreatePullRequest" | "MergeBranch")[]) => {
  db = openDb(":memory:");
  const w = createPlanPort(db, "th1").requestPlan({ key: "k1", objective: "o" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "o",
    items: [{ key: "a", role: "developer", brief: "do a", dependsOn: [], risk: "R1" }],
    acceptanceCriteria: [],
    envelope: { locations: ["repo"], riskClasses: ["R1"], bounds: { maxItems: 8, maxGb: 1 } },
    budgetUsd: 2,
    effects,
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  expect(approveVersion(db, r.plan.id, 1)).toMatchObject({ ok: true });
  return { goalId: w.goalId };
};

test("plan effects flow into the approved envelope grants (push + PR), deduped", () => {
  const { goalId } = plan(["GitPush", "CreatePullRequest", "GitPush"]);
  const env = loadEnvelope(db, goalId, ["repo"], "/tmp/goal");
  expect(env.effects.map((g) => g.tool as string).sort()).toEqual(
    [CREATE_PULL_REQUEST_TOOL, GIT_PUSH_TOOL].sort(),
  );
  expect(env.effects.every((g) => g.scope.location === "repo")).toBe(true);
});

test("a plan with no effects grants no delivery tool", () => {
  const { goalId } = plan([]);
  expect(loadEnvelope(db, goalId, ["repo"], "/tmp/goal").effects).toEqual([]);
});

test("the plan tool schema takes an `effects` list and refuses an unknown tool", () => {
  // The SDK `tool()` wraps the raw shape in a non-strict object: an unknown key (a legacy `deliveryMode`) is stripped, not
  // rejected, so no test claims a rejection there; the list itself is an allowlist enum.
  const schema = z.object(CREATE_PLAN_SHAPE);
  const ok = {
    goalId: "g",
    items: [{ key: "a", role: "developer", brief: "b", dependsOn: [], risk: "R1" }],
    acceptanceCriteria: [],
    envelope: { locations: [], riskClasses: ["R1"], bounds: { maxItems: 1, maxGb: 0 } },
    budgetUsd: 1,
  };
  expect(schema.safeParse({ ...ok, effects: ["GitPush"] }).success).toBe(true);
  expect(schema.safeParse({ ...ok, effects: ["DeletePaths"] }).success).toBe(false);
  expect(schema.safeParse(ok).success).toBe(false); // `effects` is required on a new plan
  const parsed = schema.parse({ ...ok, effects: [], deliveryMode: "keep" });
  expect("deliveryMode" in parsed).toBe(false);
});

test("a stored unknown effect is filtered out when the plan is read back", () => {
  const { goalId } = plan(["GitPush"]);
  db.query("UPDATE work_plans SET envelope = ? WHERE goal_id = ?").run(
    JSON.stringify({
      roles: [],
      locations: ["repo"],
      riskClasses: ["R1"],
      bounds: { maxItems: 8, maxGb: 1 },
      budgetUsd: 1,
      effects: ["GitPush", "DeletePaths", 7],
    }),
    goalId,
  );
  const env = loadEnvelope(db, goalId, ["repo"], "/tmp/goal");
  expect(env.effects.map((g) => g.tool as string)).toEqual([GIT_PUSH_TOOL]);
});
