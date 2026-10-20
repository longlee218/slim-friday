import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PLAN_GOAL_BUDGET_MAX_USD } from "../src/config/model-routing";
import type { ViewerConfig } from "../src/config/viewer-config";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import {
  currentVersion,
  planUrlOfGoal,
  syncPlanArtifacts,
} from "../src/orchestrator/plan/plan-artifact";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { renderPlan } from "../src/orchestrator/plan/plan-render";
import { listByGoal } from "../src/storage/artifact-store";
import { recordBotThread } from "../src/storage/thread-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { createPlanHandlerFor, plannerCtxOf } from "./plan-visibility-helpers";
import { byKey, ENV, item, setStoredBudget, TH } from "./waves-fixture";

/* Phase 5 gap tests: the plan artifact's text and reuse, edge goals (no plan, 0 items, long brief), the version in force,
   the thread scope of the plan port, and the digest key that ignores the signed link. */

const VIEWER: ViewerConfig = {
  port: 1,
  baseUrl: "https://v.example",
  secret: "s".repeat(32),
  linkTtlMs: 3_600_000,
};
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};

let db: Database;
afterEach(() => db?.close());

/** A real home, a mapped thread TH and a goal with a plan v1 (approved when `approve`). */
function world(
  o: { approve?: boolean; items?: ReturnType<typeof item>[]; objective?: string } = {},
) {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: o.objective ?? "build it",
    items: o.items ?? [item("a"), item("b", { dependsOn: ["a"] })],
    acceptanceCriteria: ["works", "tests pass"],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  setStoredBudget(db, r.plan.id, 1, PLAN_GOAL_BUDGET_MAX_USD); // at the ceiling: an added item applies at once
  if (o.approve) approveVersion(db, r.plan.id, 1);
  const deps = { db, home: env.home, viewer: VIEWER };
  return { env, goalId: w.goalId, planId: r.plan.id, deps };
}

test("the artifact text holds steps with deps, the done-when list, the limits line and per-item status", () => {
  const { goalId, deps } = world({ approve: true });
  moveTaskTo(db, byKey(db, goalId, "a").id, "running");
  syncPlanArtifacts(deps, TH, goalId);
  const text = readFileSync(listByGoal(db, goalId)[0]!.path, "utf8");
  expect(text).toMatch(/^# Plan v1: build it$/m);
  expect(text).toMatch(/^1\. a "Do a" \[developer @ repo, risk R1, running\]: do a$/m);
  expect(text).toMatch(/^2\. b "Do b" \[developer @ repo, risk R1, pending\] after a: do b$/m);
  expect(text).toContain("Done when:\n- works\n- tests pass");
  expect(text).toMatch(
    /^Limits: roles developer; locations repo; risk R0, R1; at most 8 steps and 1 GB; budget \$35; delivery: keep\.$/m,
  );
});

test("a rejected version reads as rejected with its reason and no live item status", () => {
  const { goalId, planId, deps } = world();
  rejectVersion(db, planId, 1, "scope too big");
  const [v] = syncPlanArtifacts(deps, TH, goalId);
  expect(v?.status).toBe("rejected");
  const text = readFileSync(listByGoal(db, goalId)[0]!.path, "utf8");
  expect(text).toContain("Status: rejected. Reason: scope too big");
  expect(text).not.toContain("not started");
});

test("a revision gives v2 its own artifact, v1 is rewritten as superseded, and a re-sync adds nothing", () => {
  const { goalId, planId, deps } = world({ approve: true });
  syncPlanArtifacts(deps, TH, goalId);
  createPlanHandlerFor(plannerCtxOf({ db }, goalId), planId, { add: [item("z")] });
  const infos = syncPlanArtifacts(deps, TH, goalId);
  expect(infos.map((i) => i.version)).toEqual([1, 2]);
  expect(new Set(infos.map((i) => i.artifactId)).size).toBe(2);
  const rows = listByGoal(db, goalId);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.title).sort()).toEqual(
    [`Plan ${goalId.slice(0, 8)} v1`, `Plan ${goalId.slice(0, 8)} v2`].sort(),
  );
  const v1Text = readFileSync(rows.find((r) => r.title.endsWith("v1"))!.path, "utf8");
  expect(v1Text).toContain("Status: superseded");
  expect(readFileSync(rows.find((r) => r.title.endsWith("v2"))!.path, "utf8")).toContain(
    '3. z "Do z"',
  );
  // Re-sync: same ids, same rows.
  expect(syncPlanArtifacts(deps, TH, goalId).map((i) => i.artifactId)).toEqual(
    infos.map((i) => i.artifactId),
  );
  expect(listByGoal(db, goalId)).toHaveLength(2);
});

test("the version in force is the approved one, not a newer version still waiting for the owner", () => {
  const { goalId, planId, deps } = world({ approve: true });
  // A new location grows the envelope: v2 is stored `valid` and waits for the owner.
  createPlanHandlerFor(plannerCtxOf({ db }, goalId), planId, {
    add: [item("z", { location: "docs" })],
    grow: true,
  });
  const infos = syncPlanArtifacts(deps, TH, goalId);
  expect(infos.map((i) => i.status)).toEqual(["approved", "valid"]);
  expect(currentVersion(infos)?.version).toBe(1);
  expect(currentVersion(infos)?.status).toBe("approved");
  const v1Id = infos.find((i) => i.version === 1)?.artifactId;
  expect(new URL(planUrlOfGoal(deps, TH, goalId)!).pathname).toBe(`/a/${v1Id}`);
});

test("a very long brief stays whole in the artifact; the head line stays clipped; the row size follows the file", () => {
  const brief = `${"detail ".repeat(700)}END`;
  const objective = "o".repeat(400);
  const { goalId, planId, deps } = world({
    items: [item("a", { brief })],
    objective,
  });
  syncPlanArtifacts(deps, TH, goalId);
  rejectVersion(db, planId, 1, "r");
  syncPlanArtifacts(deps, TH, goalId);
  const row = listByGoal(db, goalId)[0]!;
  const text = readFileSync(row.path, "utf8");
  expect(text).toContain(`: ${brief}`);
  expect(text).toContain("END");
  expect(text.split("\n")[0]!.length).toBeLessThan(200);
  expect(text).toContain(`Objective: ${objective}`);
  expect(row.size).toBe(Buffer.byteLength(text));
});

test("a 0-item plan is refused at storage; the renderer still writes a head and the steps header", () => {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const goalId = w.goalId;
  const r = createPlan(db, {
    goalId,
    objective: "x",
    items: [],
    acceptanceCriteria: [],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
  });
  expect(r).toMatchObject({ ok: false, code: "INVALID", errors: [{ code: "NO_ITEMS" }] });
  const text = renderPlan(
    {
      version: 1,
      objective: "x",
      doc: {
        items: [],
        acceptanceCriteria: [],
        envelope: {
          roles: [],
          locations: [],
          riskClasses: ["R0"],
          bounds: { maxItems: 1, maxGb: 1 },
          budgetUsd: 1,
          effects: [],
        },
      },
    } as never,
    { status: "valid" },
  );
  expect(text).toStartWith("# Plan v1: x\nStatus: valid\nSteps (run one after another):\n");
});
