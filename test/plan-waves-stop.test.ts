import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { MAX_WAVES, PENDING_PLAN_MAX_AGE_MS, PLAN_MAX_ITEMS } from "../src/config/lead-caps";
import { PLAN_GOAL_BUDGET_MAX_USD } from "../src/config/model-routing";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { revisePlan } from "../src/orchestrator/plan/plan-revision";
import {
  startNextWave,
  waveOutlook,
  wavePendingThreads,
} from "../src/orchestrator/plan/plan-waves";
import { stopThreadTree } from "../src/orchestrator/run/stop-thread-tree";
import { settleGoal } from "../src/orchestrator/worker/goal-settle";
import { childrenOf } from "../src/storage/owned-item-store";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import {
  approvedPlan,
  byKey,
  complete,
  ENV,
  item,
  keysOf,
  newGoal,
  spend,
  TH,
} from "./waves-fixture";

/* Rolling waves: what ends them. /stop, Orchestrate cancel, a new goal, a wave planner that leaves no approved revision, a
   stale unanswered wave plan, plan budget boundaries, and the carried envelope roles. */

let db: Database;
afterEach(() => db?.close());
const later = (key: string, over: Record<string, unknown> = {}) =>
  item(key, { deferredScope: true, ...over });
const edit = (over: object = {}) => ({ add: [], cancel: [], modify: [], ...over });
const events = (code: string) =>
  (
    db.query("SELECT payload FROM thread_events WHERE kind = 'failure'").all() as {
      payload: string;
    }[]
  )
    .map((r) => JSON.parse(r.payload))
    .filter((p) => p.code === code);
/** a done, d deferred; the wave is complete. */
function waveGoal() {
  const p = approvedPlan([item("a"), later("d")]);
  db = p.db;
  complete(db, p.goalId, "a");
  return p;
}
/** The planner item started after every plan approval so far (a planner that made no revision). */
const noRevision = (goalId: string, key: string) =>
  db
    .query("UPDATE owned_tasks SET created_at = created_at + 5000 WHERE id = ?")
    .run(byKey(db, goalId, key).id);
const port = () =>
  createDbEffectPort({
    db,
    threadId: TH,
    env: { workerRoles: ["developer"], locations: ["repo"] },
    io: {
      steerTask: () => "queued",
      askOwner: async () => ({ answer: "a", timedOut: false }),
      post: async () => {},
    },
  });
/** A wave planner that proposes a revision (approved at once) and completes. */
function plannedWave(goalId: string, planId: string, version: number, tag: string) {
  expect(startNextWave(db, goalId)).toBe(true);
  const r = revisePlan(db, {
    planId,
    baseVersion: version,
    edit: edit({ add: [later(tag)] }),
    reason: "w",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, status: "approved" });
  complete(
    db,
    goalId,
    `planner-${childrenOf(db, goalId).filter((i) => i.itemKey?.startsWith("planner")).length}`,
  );
  return version + 1;
}

test(`every planner counts toward MAX_WAVES: ${MAX_WAVES} planners in total, then the goal is held`, () => {
  const { goalId, planId } = waveGoal();
  let v = 1;
  for (let n = 2; n <= MAX_WAVES; n++) v = plannedWave(goalId, planId, v, `m${n}`);
  expect(waveOutlook(db, goalId)).toBe("capped");
  expect(startNextWave(db, goalId)).toBe(false);
});

test("a wave planner that completes without a revision: no new planner, ONE WAVE_STALLED event, goal held", () => {
  const { goalId } = waveGoal();
  expect(startNextWave(db, goalId)).toBe(true);
  complete(db, goalId, "planner-2");
  noRevision(goalId, "planner-2");
  expect(waveOutlook(db, goalId)).toBe("stalled");
  expect(startNextWave(db, goalId)).toBe(false);
  settleGoal(db, goalId);
  settleGoal(db, goalId);
  expect(events("WAVE_STALLED")).toHaveLength(1);
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
});

test("a cancelled planner-N never starts the next wave", () => {
  const { goalId } = waveGoal();
  startNextWave(db, goalId);
  moveTaskTo(db, byKey(db, goalId, "planner-2").id, "cancelled");
  expect(waveOutlook(db, goalId)).toBe("stalled");
  expect(startNextWave(db, goalId)).toBe(false);
  expect(wavePendingThreads(db)).toEqual([]);
  expect(keysOf(db, goalId).filter((k) => k.startsWith("planner"))).toHaveLength(2);
});

test("owner rejects the wave plan: stalled, no new planner", () => {
  const { goalId, planId } = waveGoal();
  startNextWave(db, goalId);
  const grown = revisePlan(db, {
    planId,
    baseVersion: 1,
    edit: edit({ effects: ["GitPush"] }),
    reason: "push it",
    env: ENV,
  });
  expect(grown).toMatchObject({ ok: true, status: "valid" });
  expect(rejectVersion(db, planId, 2, "no")).toMatchObject({ ok: true });
  complete(db, goalId, "planner-2");
  noRevision(goalId, "planner-2");
  expect(waveOutlook(db, goalId)).toBe("stalled");
  expect(startNextWave(db, goalId)).toBe(false);
});

test("an unanswered wave plan older than PENDING_PLAN_MAX_AGE_MS is stalled: no planner on top of it", () => {
  const { goalId, planId } = waveGoal();
  startNextWave(db, goalId);
  revisePlan(db, {
    planId,
    baseVersion: 1,
    edit: edit({ effects: ["GitPush"] }),
    reason: "more",
    env: ENV,
  });
  complete(db, goalId, "planner-2");
  expect(waveOutlook(db, goalId)).toBe("waiting"); // fresh: the owner may still answer
  db.query("UPDATE work_plans SET created_at = created_at - ? WHERE status = 'valid'").run(
    PENDING_PLAN_MAX_AGE_MS + 1000,
  );
  expect(waveOutlook(db, goalId)).toBe("stalled");
  expect(startNextWave(db, goalId)).toBe(false);
  settleGoal(db, goalId);
  expect(events("WAVE_STALLED")).toHaveLength(1);
});

test("/stop during a wave: the not-started wave planner is cancelled, the goal closes, nothing restarts", () => {
  const { goalId } = waveGoal();
  startNextWave(db, goalId);
  stopThreadTree(db, TH);
  expect(byKey(db, goalId, "planner-2").status).toBe("cancelled");
  expect(getOwnedTask(db, goalId)?.status).toBe("cancelled");
  expect(events("WAVE_STALLED")).toHaveLength(0); // a stop is not news
  expect(wavePendingThreads(db)).toEqual([]);
  expect(startNextWave(db, goalId)).toBe(false);
});

test("/stop of an idle goal (wave done, planner not inserted yet) closes it: no wave at the next pass or boot", () => {
  const { goalId } = waveGoal();
  expect(wavePendingThreads(db)).toEqual([TH]);
  stopThreadTree(db, TH);
  expect(getOwnedTask(db, goalId)?.status).toBe("cancelled");
  expect(wavePendingThreads(db)).toEqual([]);
  expect(startNextWave(db, goalId)).toBe(false);
});

test("Orchestrate cancel <goalId> settles an idle goal: capped, stalled and ready alike", () => {
  for (const mode of ["capped", "stalled", "ready"] as const) {
    const { goalId, planId } = waveGoal();
    if (mode === "stalled") {
      startNextWave(db, goalId);
      complete(db, goalId, "planner-2");
      noRevision(goalId, "planner-2");
    } else if (mode === "capped") {
      let v = 1;
      for (let n = 2; n <= MAX_WAVES; n++) v = plannedWave(goalId, planId, v, `m${n}`);
    }
    expect(waveOutlook(db, goalId)).toBe(mode);
    const moved = port().cancel(goalId, "owner");
    expect(moved).toContain(goalId);
    expect(getOwnedTask(db, goalId)?.status).toBe("cancelled");
    expect(wavePendingThreads(db)).toEqual([]);
    db.close();
  }
});

test("a NEW goal in the thread cancels the old idle wave goal: its waves never restart behind it", () => {
  const { goalId } = waveGoal();
  expect(wavePendingThreads(db)).toEqual([TH]);
  expect(
    createPlanPort(db, TH).requestPlan({ key: "k9", objective: "something else" }),
  ).toMatchObject({ ok: true });
  expect(getOwnedTask(db, goalId)?.status).toBe("cancelled");
  expect(wavePendingThreads(db)).toEqual([]);
});

test("computed plan budget vs the goal's spend: room is added above the spend, at the ceiling the plan is refused", () => {
  const plan = (spentUsd: number) => {
    const g = newGoal();
    db = g.db;
    if (spentUsd) spend(db, byKey(db, g.goalId, "planner").id, spentUsd);
    return createPlan(db, {
      goalId: g.goalId,
      objective: "o",
      items: [item("a")], // one developer run, no criteria: ceil(8 * 1.25) = $10
      acceptanceCriteria: [],
      envelope: {
        locations: ["repo"],
        riskClasses: ["R1"],
        bounds: { maxItems: PLAN_MAX_ITEMS, maxGb: 1 },
      },
      effects: [],
      env: ENV,
    });
  };
  const budgetOf = (r: ReturnType<typeof plan>) => (r.ok ? r.plan.budgetUsd : r.message);
  expect(budgetOf(plan(4))).toBe(10); // own budget above the spend
  expect(budgetOf(plan(12))).toBe(22); // not above: spend + reserved sum
  expect(budgetOf(plan(30))).toBe(PLAN_GOAL_BUDGET_MAX_USD); // capped
  for (const spent of [PLAN_GOAL_BUDGET_MAX_USD, 40]) {
    const r = plan(spent);
    expect(r).toMatchObject({ ok: false, code: "INVALID" });
    expect(r.ok === false && r.message).toContain("must be above what the goal already spent");
  }
});

test("approval re-checks the budget: a plan stored valid is refused once the goal spent up to it", () => {
  const g = newGoal();
  db = g.db;
  const r = createPlan(db, {
    goalId: g.goalId,
    objective: "o",
    items: [item("a")],
    acceptanceCriteria: [],
    envelope: { locations: ["repo"], riskClasses: ["R1"], bounds: { maxItems: 4, maxGb: 1 } },
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  expect(r.plan.budgetUsd).toBe(10);
  spend(db, byKey(db, g.goalId, "planner").id, 10);
  expect(approveVersion(db, r.plan.id, 1)).toMatchObject({ ok: false, code: "BUDGET" });
  expect(childrenOf(db, g.goalId).map((i) => i.itemKey)).toEqual(["planner"]); // nothing created
});

test("roles of the approved version stay in the envelope: pruned items do not make a later wave 'grow'", () => {
  const scouts = Array.from({ length: 10 }, (_, i) => item(`s${i}`, { role: "scout" }));
  const deferred = Array.from({ length: 10 }, (_, i) => later(`d${i}`));
  const p = approvedPlan([...scouts, ...deferred]);
  db = p.db;
  for (const s of scouts) complete(db, p.goalId, s.key);
  // Wave 2: 10 activated + 10 new = 30 items: the 10 completed scout items leave the version.
  const w2 = revisePlan(db, {
    planId: p.planId,
    baseVersion: 1,
    edit: edit({
      modify: deferred.map((d) => ({ key: d.key, deferredScope: false })),
      add: [...Array.from({ length: 9 }, (_, i) => item(`n${i}`)), later("more")],
    }),
    reason: "wave 2",
    env: ENV,
  });
  expect(w2).toMatchObject({ ok: true, status: "approved" });
  // Wave 3 needs a scout again: the role was approved in v1, so no owner question.
  for (const k of [...deferred.map((d) => d.key), ...Array.from({ length: 9 }, (_, i) => `n${i}`)])
    complete(db, p.goalId, k);
  const w3 = revisePlan(db, {
    planId: p.planId,
    baseVersion: 2,
    edit: edit({ add: [item("late-scout", { role: "scout" })] }),
    reason: "wave 3",
    env: ENV,
  });
  expect(w3).toMatchObject({ ok: true, status: "approved" });
});
