import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { ViewerConfig } from "../src/config/viewer-config";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import type { LeadRuntime } from "../src/orchestrator/lead/lead-runtime";
import { planUrlOfGoal, syncPlanArtifacts } from "../src/orchestrator/plan/plan-artifact";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import {
  createPlanHandler,
  proposeRevisionHandler,
} from "../src/orchestrator/plan/planner-handlers";
import { createCheckIn } from "../src/orchestrator/worker/check-in";
import { digestFacts, factsKey } from "../src/orchestrator/worker/digest-facts";
import { listByGoal } from "../src/storage/artifact-store";
import { recordBotThread } from "../src/storage/thread-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { plannerCtxOf } from "./plan-visibility-helpers";
import { byKey, ENV, item, TH } from "./waves-fixture";

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
  if (o.approve) approveVersion(db, r.plan.id, 1);
  const deps = { db, home: env.home, viewer: VIEWER };
  return { env, goalId: w.goalId, planId: r.plan.id, deps };
}

test("a goal without a plan: no artifact, no link, no digest plan line", () => {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const deps = { db, home: env.home, viewer: VIEWER };
  expect(syncPlanArtifacts(deps, TH, w.goalId)).toEqual([]);
  expect(planUrlOfGoal(deps, TH, w.goalId)).toBeUndefined();
  expect(listByGoal(db, w.goalId)).toEqual([]);
  expect(digestFacts(db, w.goalId, "build it", 1).planVersion).toBeUndefined();
});

test("the digest key ignores the signed link: a new secret or TTL with the same facts posts nothing", async () => {
  const { goalId, env } = world({ approve: true });
  moveTaskTo(db, byKey(db, goalId, "a").id, "running");
  const f = digestFacts(db, goalId, "build it", 1);
  const posts: string[] = [];
  const mk = (viewer: ViewerConfig) =>
    ({
      deps: { db, config: { ...env.config, viewer } },
      announce: () => {},
      ctxOf: () => ({
        message: {
          text: "hi",
          language: "en",
          notify: async (text: string) => void posts.push(text),
        },
      }),
    }) as unknown as LeadRuntime;
  const tick = createCheckIn();
  await tick(mk(VIEWER), 10_000_000);
  expect(posts).toHaveLength(1);
  const rotated = { ...VIEWER, secret: "t".repeat(32), linkTtlMs: 7_200_000 };
  expect(factsKey(f)).toBe(factsKey(digestFacts(db, goalId, "build it", 2)));
  await tick(mk(rotated), 10_000_000 + 3_600_000);
  expect(posts).toHaveLength(1);
});

test("a re-plan after a reject gets its own artifact per version (the rejected one is kept)", () => {
  const { goalId, planId, deps } = world();
  rejectVersion(db, planId, 1, "no");
  const ctx = plannerCtxOf({ db }, goalId);
  const r = createPlanHandler(ctx, {
    goalId,
    items: [item("n")],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    budgetUsd: 3,
    effects: [],
    confirmNew: true,
  } as never);
  expect(r).toMatchObject({ ok: true, version: 2 });
  const infos = syncPlanArtifacts(deps, TH, goalId);
  expect(infos.map((i) => i.status)).toEqual(["rejected", "valid"]);
  expect(listByGoal(db, goalId)).toHaveLength(2);
});

test("a revision that changes only a brief is a digest change: the plan version is in the key", async () => {
  const { goalId, planId, env, deps } = world({ approve: true });
  moveTaskTo(db, byKey(db, goalId, "a").id, "running");
  const posts: string[] = [];
  const rt = {
    deps: { db, config: { ...env.config, viewer: VIEWER } },
    announce: () => {},
    ctxOf: () => ({
      message: { text: "hi", language: "en", notify: async (t: string) => void posts.push(t) },
    }),
  } as unknown as LeadRuntime;
  const tick = createCheckIn();
  await tick(rt, 10_000_000);
  expect(posts).toHaveLength(1);
  // Same items, same statuses, same counts: only the brief of b (not started) changes.
  proposeRevisionHandler(plannerCtxOf(deps, goalId), {
    planId,
    baseVersion: 1,
    add: [],
    cancel: [],
    modify: [{ key: "b", brief: "do b another way" }],
    reason: "brief only",
  } as never);
  await tick(rt, 10_000_000 + 7_200_000);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toContain("Plan: v2");
});
