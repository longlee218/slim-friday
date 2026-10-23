import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import type { PlanSideEffects } from "../src/orchestrator/plan/plan-side-effects";
import {
  handleCreatePlan,
  handleRevisePlan,
} from "../src/orchestrator/teammate/teammate-plan-handlers";
import { openDb } from "../src/storage/db";
import { childrenOf } from "../src/storage/owned-item-store";
import { FakePort, teammateCtx } from "./teammate-fake-port";

/* The teammate writes the plan itself: `create_plan` stores goal + version in one transaction, `revise_plan` a new version.
   Db level (the real port) plus the handler over a fake port (policy, side effects). */

let db: Database;
afterEach(() => db?.close());
const ENV = { workerRoles: ["developer", "tester"], locations: ["repo"] };
const port = () => {
  db = openDb(":memory:");
  return createPlanPort(db, "th1", undefined, () => ENV);
};
const input = (over: Record<string, unknown> = {}) => ({
  objective: "Add login",
  items: [
    {
      key: "build",
      subject: "Build login",
      priority: 0,
      role: "developer",
      brief: "goal: login",
      location: "repo",
      dependsOn: [],
      risk: "R1",
    },
  ],
  acceptanceCriteria: ["go test passes"],
  envelope: { locations: ["repo"], riskClasses: ["R1"], bounds: { maxItems: 4, maxGb: 1 } },
  effects: [],
  ...over,
});

test("create_plan opens the goal and stores a valid version 1 with no planner item", () => {
  const p = port();
  const w = p.createPlan(input() as never);
  expect(w).toMatchObject({ ok: true, version: 1, status: "valid" });
  if (!w.ok) return;
  expect(childrenOf(db, w.goalId)).toEqual([]); // no planner run: items appear when the owner approves
  expect(p.plan(w.planId, 1)?.goalId).toBe(w.goalId);
  const approved = p.decidePlan(w.planId, 1, true);
  expect(approved).toMatchObject({ ok: true });
  expect(childrenOf(db, w.goalId).map((i) => i.itemKey)).toContain("build");
});

test("a refused plan leaves no goal behind", () => {
  const p = port();
  const w = p.createPlan(input({ items: [{ ...input().items[0], role: "wizard" }] }) as never);
  expect(w.ok).toBe(false);
  expect(db.query("SELECT COUNT(*) AS n FROM owned_tasks").get()).toEqual({ n: 0 });
});

test("revise_plan makes a new version of a stored plan", () => {
  const p = port();
  const w = p.createPlan(input() as never);
  if (!w.ok) throw new Error("create");
  const r = p.revisePlan({
    planId: w.planId,
    baseVersion: 1,
    reason: "owner dropped it",
    edit: { add: [], cancel: ["build"], modify: [] },
  });
  expect(r.ok).toBe(false); // the last item cannot be cancelled: a plan keeps at least one
  const ok = p.revisePlan({
    planId: w.planId,
    baseVersion: 1,
    reason: "tighter brief",
    edit: { add: [], cancel: [], modify: [{ key: "build", brief: "goal: login v2" }] },
  });
  expect(ok).toMatchObject({ ok: true, version: 2, status: "valid" });
});

test("handler: one plan per teammate run, artifact and owner line follow a stored version", async () => {
  const fake = new FakePort();
  const calls: string[] = [];
  const plan: PlanSideEffects = {
    onVersion: (g) => void calls.push(`version:${g}`),
    notify: (g) => void calls.push(`notify:${g}`),
  };
  const ctx = { ...teammateCtx(fake), plan };
  const a = await handleCreatePlan(ctx, input() as never);
  expect(a).toMatchObject({ ok: true, version: 1 });
  expect(calls).toEqual(["version:goal-p"]);
  const b = await handleCreatePlan(ctx, input({ objective: "other" }) as never);
  expect(b).toMatchObject({ ok: false, code: "ONE_PER_RUN" });
});

test("handler: a refusal of the port is the reply and nothing follows", async () => {
  const fake = new FakePort();
  fake.planWrite = { ok: false, code: "INVALID", message: "bad key" };
  const calls: string[] = [];
  const ctx = {
    ...teammateCtx(fake),
    plan: { onVersion: () => void calls.push("v"), notify: () => {} },
  };
  expect(await handleCreatePlan(ctx, input() as never)).toMatchObject({
    ok: false,
    code: "INVALID",
  });
  expect(calls).toEqual([]);
  const r = await handleRevisePlan(ctx, {
    planId: "p",
    baseVersion: 1,
    add: [],
    cancel: [],
    modify: [],
    reason: "x",
  } as never);
  expect(r).toMatchObject({ ok: false, code: "INVALID" });
});
