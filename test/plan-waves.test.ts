import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { MAX_WAVES, PLAN_MAX_ITEMS } from "../src/config/lead-caps";
import { ITEM_MAX_AGE_MS } from "../src/config/resilience-caps";
import type { LeadRuntime } from "../src/orchestrator/lead/lead-runtime";
import { revisePlan } from "../src/orchestrator/plan/plan-revision";
import {
  startNextWave,
  waveOutlook,
  wavePendingThreads,
} from "../src/orchestrator/plan/plan-waves";
import { digestFacts } from "../src/orchestrator/worker/digest-facts";
import { settleGoal } from "../src/orchestrator/worker/goal-settle";
import { sweepItemAge } from "../src/orchestrator/worker/item-age";
import { recoverInFlight } from "../src/orchestrator/worker/recover-in-flight";
import { agedItems } from "../src/storage/item-age-store";
import { childrenOf } from "../src/storage/owned-item-store";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { approvedPlan, byKey, complete, ENV, item, keysOf, TH } from "./waves-fixture";

/* Rolling waves over a real db: when the next wave starts, the cap, the settle guard, auto-approve vs owner, restart
   idempotency, the version cap, and the age and digest of a wave planner item. */

let db: Database;
afterEach(() => db?.close());
const later = (key: string, over: Record<string, unknown> = {}) =>
  item(key, { deferredScope: true, ...over });
const edit = (over: object = {}) => ({ add: [], cancel: [], modify: [], ...over });
/** Plan with `a` active and `d` deferred; `a` completed unless said otherwise. */
function waveGoal(done = true) {
  const p = approvedPlan([item("a"), later("d")]);
  db = p.db;
  if (done) complete(db, p.goalId, "a");
  return p;
}

test("wave trigger: waiting while an item is live, ready when the wave completed, then a planner-2 item (once)", () => {
  const { goalId } = waveGoal(false);
  expect(waveOutlook(db, goalId)).toBe("waiting"); // `a` is still ready
  complete(db, goalId, "a");
  expect(waveOutlook(db, goalId)).toBe("ready");
  settleGoal(db, goalId); // scope is deferred: the goal does not settle
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
  expect(startNextWave(db, goalId)).toBe(true);
  const p2 = byKey(db, goalId, "planner-2");
  expect(p2).toMatchObject({ ownerRole: "planner", status: "ready" });
  expect(p2.brief).toContain("Wave 2 of at most");
  expect(p2.brief).toContain("Objective: build it");
  expect(p2.brief).toContain("- d (developer): do d"); // the deferred list, as data
  expect(waveOutlook(db, goalId)).toBe("waiting"); // the live planner
  expect(startNextWave(db, goalId)).toBe(false);
  expect(keysOf(db, goalId).filter((k) => k.startsWith("planner"))).toHaveLength(2);
  const start = listUndelivered(db, TH).find((e) => e.id === `wave:${goalId}:planner-2`);
  expect(start).toMatchObject({ kind: "start", payload: { by: "code", wave: 2 } });
});

test("no wave without deferred scope; a failed item abandons the deferred scope and the goal settles failed", () => {
  const plain = approvedPlan([item("a")]);
  complete(plain.db, plain.goalId, "a");
  expect(waveOutlook(plain.db, plain.goalId)).toBe("none");
  expect(startNextWave(plain.db, plain.goalId)).toBe(false);
  plain.db.close();
  const { goalId } = waveGoal(false);
  const a = byKey(db, goalId, "a");
  for (const s of ["ready", "running", "failed"] as const) moveTaskTo(db, a.id, s);
  expect(waveOutlook(db, goalId)).toBe("abandoned");
  expect(startNextWave(db, goalId)).toBe(false);
  settleGoal(db, goalId);
  expect(getOwnedTask(db, goalId)?.status).toBe("failed");
});

test(`wave cap: at ${MAX_WAVES} planners the goal is held with ONE failure event (WAVE_CAP), not settled`, () => {
  const { goalId, planId } = waveGoal();
  // Each planner proposes a revision that keeps scope deferred: the next wave is due, up to the cap.
  for (let n = 2; n <= MAX_WAVES; n++) {
    expect(startNextWave(db, goalId)).toBe(true);
    revisePlan(db, {
      planId,
      baseVersion: n - 1,
      edit: edit({ add: [later(`m${n}`)] }),
      reason: "w",
      env: ENV,
    });
    complete(db, goalId, `planner-${n}`);
  }
  expect(waveOutlook(db, goalId)).toBe("capped");
  expect(startNextWave(db, goalId)).toBe(false);
  settleGoal(db, goalId);
  settleGoal(db, goalId);
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
  const caps = listUndelivered(db, TH).filter((e) => (e.payload as any)?.code === "WAVE_CAP");
  expect(caps).toHaveLength(1);
  expect(caps[0]).toMatchObject({ kind: "failure", payload: { cause: "wave cap" } });
});

test("a plan version waiting for the owner holds the wave (no second planner) and the settle", () => {
  const { goalId, planId } = waveGoal();
  const r = revisePlan(db, {
    planId,
    baseVersion: 1,
    edit: edit({
      add: [item("c", { location: "docs" })],
      envelope: {
        locations: ["repo", "docs"],
        riskClasses: ["R0", "R1"],
        bounds: { maxItems: PLAN_MAX_ITEMS, maxGb: 1 },
      },
    }),
    reason: "docs too",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, status: "valid" }); // envelope grew: the owner decides
  expect(waveOutlook(db, goalId)).toBe("waiting");
  expect(startNextWave(db, goalId)).toBe(false);
  settleGoal(db, goalId);
  expect(getOwnedTask(db, goalId)?.status).toBe("open");
});

test("wave revision: applies at once when the envelope and budget are unchanged, activating a deferred item (no row yet)", () => {
  const { goalId, planId } = waveGoal();
  const r = revisePlan(db, {
    planId,
    baseVersion: 1,
    edit: edit({ modify: [{ key: "d", deferredScope: false }], add: [later("e")] }),
    reason: "wave 2",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, status: "approved", affected: { created: ["d"] } });
  expect(byKey(db, goalId, "d").status).toBe("ready");
  expect(keysOf(db, goalId).some((k) => k.startsWith("verify"))).toBe(false); // `e` is still deferred
});

test("wave revision that adds a role, a location, an effect, a bound or raises the budget goes to the owner (valid, nothing created)", () => {
  const same = {
    locations: ["repo"],
    riskClasses: ["R0", "R1"],
    bounds: { maxItems: PLAN_MAX_ITEMS, maxGb: 1 },
  };
  const cases: object[] = [
    { add: [later("e")] }, // a new (deferred) developer item raises the code-computed budget
    { add: [item("s", { role: "scout" })] },
    { effects: ["GitPush"] },
    { envelope: { ...same, riskClasses: ["R0", "R1", "R2"] } },
    { envelope: { ...same, bounds: { maxItems: PLAN_MAX_ITEMS, maxGb: 2 } } },
  ];
  for (const c of cases) {
    const p = approvedPlan([item("a"), later("d")], { budget: null });
    complete(p.db, p.goalId, "a");
    const r = revisePlan(p.db, {
      planId: p.planId,
      baseVersion: 1,
      edit: edit({ modify: [{ key: "d", deferredScope: false }], ...c }),
      reason: "wave",
      env: ENV,
    });
    expect(r, JSON.stringify(c)).toMatchObject({ ok: true, status: "valid" });
    expect(byKey(p.db, p.goalId, "d")).toBeUndefined(); // not materialized until the owner approves
    p.db.close();
  }
});

test("a full version drops its completed items so the next wave fits; their keys stay usable as dependencies", () => {
  const active = Array.from({ length: 12 }, (_, i) => item(`w1-${i}`));
  const deferred = Array.from({ length: 8 }, (_, i) => later(`d${i}`));
  const p = approvedPlan([...active, ...deferred]);
  db = p.db;
  for (const a of active) complete(db, p.goalId, a.key);
  const wave2 = Array.from({ length: 12 }, (_, i) =>
    item(`w2-${i}`, { dependsOn: i === 0 ? ["w1-0"] : [] }),
  );
  const r = revisePlan(db, {
    planId: p.planId,
    baseVersion: 1,
    edit: edit({ modify: deferred.map((d) => ({ key: d.key, deferredScope: false })), add: wave2 }),
    reason: "wave 2",
    env: ENV,
  });
  expect(r).toMatchObject({ ok: true, status: "approved" });
  if (!r.ok) return;
  expect(r.affected.created).toHaveLength(20);
  expect(childrenOf(db, p.goalId).filter((i) => i.itemKey?.startsWith("w1-"))).toHaveLength(12); // rows and results stay
  const tooMany = revisePlan(db, {
    planId: p.planId,
    baseVersion: r.version,
    edit: edit({ add: Array.from({ length: 5 }, (_, i) => item(`x${i}`)) }),
    reason: "too many",
    env: ENV,
  });
  expect(tooMany).toMatchObject({ ok: false, code: "INVALID" }); // nothing completed to drop: the cap holds
});

test("restart between 'wave complete' and 'planner inserted': boot finds the thread, a double start inserts ONE planner-2", () => {
  const { goalId } = waveGoal();
  expect(wavePendingThreads(db)).toEqual([TH]);
  expect(recoverInFlight(db).waveThreads).toEqual([TH]); // lead-system wakes dispatchReady for it
  expect(startNextWave(db, goalId)).toBe(true);
  expect(startNextWave(db, goalId)).toBe(false); // a second boot / pass
  expect(wavePendingThreads(db)).toEqual([]);
  expect(recoverInFlight(db).waveThreads).toEqual([]);
  expect(keysOf(db, goalId).filter((k) => k.startsWith("planner"))).toEqual([
    "planner:completed",
    "planner-2:ready",
  ]);
});

test("verify is appended only by the approval that leaves nothing deferred, waiting for every item of every wave", () => {
  const { goalId, planId } = waveGoal();
  expect(keysOf(db, goalId).some((k) => k.startsWith("verify"))).toBe(false);
  const mid = revisePlan(db, {
    planId,
    baseVersion: 1,
    edit: edit({ modify: [{ key: "d", deferredScope: false }], add: [later("e")] }),
    reason: "wave 2",
    env: ENV,
  });
  expect(mid.ok).toBe(true);
  expect(keysOf(db, goalId).some((k) => k.startsWith("verify"))).toBe(false);
  complete(db, goalId, "d");
  const last = revisePlan(db, {
    planId,
    baseVersion: 2,
    edit: edit({ modify: [{ key: "e", deferredScope: false }] }),
    reason: "last wave",
    env: ENV,
  });
  expect(last.ok).toBe(true);
  const verifies = keysOf(db, goalId).filter((k) => k.startsWith("verify"));
  expect(verifies).toEqual(["verify-1:pending"]); // ONE verify, at the end
  expect(byKey(db, goalId, "verify-1").dependsOn).toEqual(["a", "d", "e"]);
});

test("a wave planner item ages like any item (8 h) and shows in the digest with its key", () => {
  const { goalId } = waveGoal();
  startNextWave(db, goalId);
  const p2 = byKey(db, goalId, "planner-2");
  const T0 = 1_000_000_000_000;
  db.query("UPDATE owned_tasks SET last_progress_at = ? WHERE id = ?").run(T0, p2.id);
  expect(agedItems(db, T0 + ITEM_MAX_AGE_MS - 1, ITEM_MAX_AGE_MS).map((a) => a.id)).toEqual([]);
  expect(agedItems(db, T0 + ITEM_MAX_AGE_MS + 1, ITEM_MAX_AGE_MS).map((a) => a.id)).toEqual([
    p2.id,
  ]);
  const rt = { deps: { db }, announce: () => {} } as unknown as LeadRuntime;
  expect(sweepItemAge(rt, T0 + ITEM_MAX_AGE_MS + 1)).toBe(1);
  expect(byKey(db, goalId, "planner-2")).toMatchObject({ status: "blocked", resultKind: "FAILED" });
  const facts = digestFacts(db, goalId, "build it", T0);
  expect(facts.items.map((i) => `${i.key}/${i.role}/${i.status}/${i.held}`)).toEqual([
    "planner-2/planner/blocked/true",
  ]);
  expect(waveOutlook(db, goalId)).toBe("waiting"); // held for the lead: no second planner
  expect(startNextWave(db, goalId)).toBe(false);
});

test("computed budget on revise: activating a counted deferred item keeps it, a cancel never lowers an approved one", () => {
  const p = approvedPlan([item("a"), later("d"), later("e")], { budget: null });
  db = p.db;
  const budget = (v: number) =>
    (db.query("SELECT budget_usd AS b FROM work_plans WHERE version = ?").get(v) as { b: number })
      .b;
  expect(budget(1)).toBe(35); // (3 developer runs * 8 + 1 verify * 4) * 1.25 = 35, at the ceiling
  complete(db, p.goalId, "a");
  const wave = revisePlan(db, {
    planId: p.planId,
    baseVersion: 1,
    edit: edit({ modify: [{ key: "d", deferredScope: false }], cancel: ["e"] }),
    reason: "wave 2, e dropped",
    env: ENV,
  });
  expect(wave).toMatchObject({ ok: true, status: "approved", affected: { created: ["d"] } });
  expect(budget(2)).toBe(35); // computed (8 + 8 + 4) * 1.25 = 25, the approved 35 is kept
});
