import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { renderUserNotice } from "../src/ingress/user-copy";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { approveVersion, createPlan } from "../src/orchestrator/plan/plan-lifecycle";
import { renderPlan } from "../src/orchestrator/plan/plan-render";
import {
  diffVersions,
  type RevisionDiff,
  revisionNotice,
} from "../src/orchestrator/plan/plan-revised";
import type { PlanDoc } from "../src/orchestrator/plan/plan-types";
import {
  createPlanHandler,
  proposeRevisionHandler,
} from "../src/orchestrator/plan/planner-handlers";
import { recordBotThread } from "../src/storage/thread-store";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { plannerCtxOf } from "./plan-visibility-helpers";
import { ENV, item, TH } from "./waves-fixture";

/* Phase 5 gap tests: the revision diff counts (+ added, − cancelled, ~ modified, criteria), the one line per applied
   revision, the owner approval text kept apart from the stored version text. */

let db: Database;
afterEach(() => db?.close());

const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};
/** A plan doc with the given items and criteria (the envelope is fixed). */
const docOf = (items: ReturnType<typeof item>[], criteria = ["works"]): PlanDoc =>
  ({
    items,
    acceptanceCriteria: criteria,
    envelope: {
      roles: ["developer"],
      locations: ["repo"],
      riskClasses: ["R0", "R1"],
      bounds: { maxItems: 8, maxGb: 1 },
      budgetUsd: 3,
      effects: [],
    },
  }) as PlanDoc;

test("diffVersions counts added, cancelled and modified items by key, and flags a criteria change", () => {
  const before = docOf([item("a"), item("b"), item("c")]);
  const after = docOf([item("a", { brief: "changed" }), item("c"), item("d")], ["works", "more"]);
  const d = diffVersions(before, after, { from: 1, version: 2, reason: "why" });
  expect(d).toEqual({
    from: 1,
    version: 2,
    added: ["d"],
    cancelled: ["b"],
    modified: ["a"],
    criteriaChanged: true,
    reason: "why",
  });
});

test("diffVersions: an identical version has no change; a priority or dependency edit counts as modified", () => {
  const same = docOf([item("a"), item("b", { dependsOn: ["a"] })]);
  expect(diffVersions(same, same, { from: 1, version: 2, reason: "r" })).toEqual({
    from: 1,
    version: 2,
    added: [],
    cancelled: [],
    modified: [],
    criteriaChanged: false,
    reason: "r",
  });
  const edited = docOf([item("a"), item("b", { dependsOn: [] })]);
  expect(diffVersions(same, edited, { from: 1, version: 2, reason: "r" }).modified).toEqual(["b"]);
  const prio = docOf([item("a", { priority: 2 }), item("b", { dependsOn: ["a"] })]);
  expect(diffVersions(same, prio, { from: 1, version: 2, reason: "r" }).modified).toEqual(["a"]);
});

test("the line counts a modified item as ~1 and nothing as +0 −0", () => {
  const n = revisionNotice({
    from: 1,
    version: 2,
    added: [],
    cancelled: [],
    modified: ["b"],
    criteriaChanged: false,
    reason: "r",
  });
  expect(renderUserNotice(n, "en")).toBe("Plan v1 → v2: +0, −0, ~1");
  expect(renderUserNotice(n, "vi")).toBe("Kế hoạch v1 → v2: +0, −0, ~1");
});

test("an applied brief edit posts one line with ~1 and the planner ctx receives the diff", () => {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items: [item("a"), item("b")],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    budgetUsd: 3,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  approveVersion(db, r.plan.id, 1);
  const diffs: RevisionDiff[] = [];
  const ctx = plannerCtxOf({ db }, w.goalId, { notify: (d) => diffs.push(d) });
  const out = proposeRevisionHandler(ctx, {
    planId: r.plan.id,
    baseVersion: 1,
    add: [],
    cancel: [],
    modify: [{ key: "b", brief: "do b differently" }],
    reason: "scope note",
  } as never);
  expect(out).toMatchObject({ ok: true, status: "approved", version: 2 });
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({ version: 2, modified: ["b"], added: [], cancelled: [] });
  expect(renderUserNotice(revisionNotice(diffs[0]!), "en")).toBe("Plan v1 → v2: +0, −0, ~1");
});

test("a no-op revision (nothing added, cancelled or modified) posts nothing", () => {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items: [item("a")],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    budgetUsd: 3,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  approveVersion(db, r.plan.id, 1);
  const diffs: RevisionDiff[] = [];
  const out = proposeRevisionHandler(
    plannerCtxOf({ db }, w.goalId, { notify: (d) => diffs.push(d) }),
    {
      planId: r.plan.id,
      baseVersion: 1,
      add: [],
      cancel: [],
      modify: [],
      reason: "same",
    } as never,
  );
  expect(out).toMatchObject({ ok: true, version: 2 });
  expect(diffs).toHaveLength(0);
});

test("the owner approval text keeps the approve sentence; the stored version text does not", () => {
  const doc = docOf([item("a")]);
  const approval = renderPlan({ version: 1, objective: "x", doc });
  expect(approval).toContain(
    "Approving runs the whole plan inside these limits without asking again.",
  );
  expect(approval).toStartWith("Plan v1: x\n");
  const stored = renderPlan({ version: 1, objective: "x", doc }, { status: "valid" });
  expect(stored).not.toContain("Approving runs");
  expect(stored).toStartWith("# Plan v1: x\nStatus: valid\n");
});

test("the first version of a plan posts no revision line (the approval question carries it)", () => {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const diffs: RevisionDiff[] = [];
  const out = createPlanHandler(plannerCtxOf({ db }, w.goalId, { notify: (d) => diffs.push(d) }), {
    goalId: w.goalId,
    items: [item("a")],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    budgetUsd: 3,
    effects: [],
  } as never);
  expect(out).toMatchObject({ ok: true, version: 1 });
  expect(diffs).toHaveLength(0);
});
