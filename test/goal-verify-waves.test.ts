import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { MAX_FIX_LOOPS } from "../src/config/resilience-caps";
import { afterVerify } from "../src/orchestrator/plan/goal-verify";
import { revisePlan } from "../src/orchestrator/plan/plan-revision";
import type { FailureVerdict } from "../src/orchestrator/worker/failure-policy";
import { settleGoal } from "../src/orchestrator/worker/goal-settle";
import { getItem, isHeld } from "../src/storage/owned-item-store";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { approvedPlan, byKey, complete, ENV, failVerify, item, keysOf, TH } from "./waves-fixture";

/* Verify over several locations and after plan revisions (the two P4 gaps): one verify chain per location, the newest
   verify of EACH location decides, the fix cap is per location, a revision after a verify started appends a new verify. */

let db: Database;
afterEach(() => db?.close());
const REPORTED: FailureVerdict = {
  action: "hold",
  class: "real",
  cause: "worker_failed",
  attempt: 0,
};
const BOTH = { locations: ["repo", "docs"] };
const edit = (over: object = {}) => ({ add: [], cancel: [], modify: [], ...over });
const status = (g: string) => getOwnedTask(db, g)?.status;
/** Two writers, one per location. */
function twoLocations() {
  const p = approvedPlan([item("a"), item("b", { location: "docs" })], BOTH);
  db = p.db;
  return p;
}

test("one verify item per writer location, numbered in one sequence, each waiting for every item, each told its location", () => {
  const { goalId } = twoLocations();
  expect(keysOf(db, goalId).slice(1)).toEqual([
    "a:ready",
    "b:ready",
    "verify-1:pending",
    "verify-2:pending",
  ]);
  expect(byKey(db, goalId, "verify-1")).toMatchObject({ location: "repo", dependsOn: ["a", "b"] });
  expect(byKey(db, goalId, "verify-2")).toMatchObject({ location: "docs", dependsOn: ["a", "b"] });
  expect(byKey(db, goalId, "verify-1").brief).toContain("You run in location repo");
  // One location only: no location line, the P4 shape.
  const one = approvedPlan([item("a")]);
  expect(byKey(one.db, one.goalId, "verify-1").brief).not.toContain("You run in location");
  one.db.close();
});

test("a failed verify loops in ITS location only; the goal settles when the newest verify of EACH location passed", () => {
  const { goalId } = twoLocations();
  complete(db, goalId, "a");
  complete(db, goalId, "b");
  expect(afterVerify(db, failVerify(db, goalId, "verify-1"), REPORTED)).toBe(true);
  expect(keysOf(db, goalId).slice(-4)).toEqual([
    "verify-1:cancelled",
    "verify-2:pending",
    "fix-1:ready",
    "verify-3:pending",
  ]);
  expect(byKey(db, goalId, "fix-1")).toMatchObject({ location: "repo", ownerRole: "developer" });
  expect(byKey(db, goalId, "verify-3")).toMatchObject({ location: "repo", dependsOn: ["fix-1"] });
  complete(db, goalId, "verify-2"); // docs passed
  settleGoal(db, goalId);
  expect(status(goalId)).toBe("open"); // repo's newest verify is still to run
  complete(db, goalId, "fix-1");
  complete(db, goalId, "verify-3");
  settleGoal(db, goalId);
  expect(status(goalId)).toBe("completed");
});

test("the fix cap is per location: repo is capped after 2 fixes while docs still gets its own", () => {
  const { goalId } = twoLocations();
  complete(db, goalId, "a");
  complete(db, goalId, "b");
  expect(afterVerify(db, failVerify(db, goalId, "verify-1"), REPORTED)).toBe(true); // fix-1, verify-3
  complete(db, goalId, "fix-1");
  expect(afterVerify(db, failVerify(db, goalId, "verify-3"), REPORTED)).toBe(true); // fix-2, verify-4
  complete(db, goalId, "fix-2");
  const capped = failVerify(db, goalId, "verify-4");
  expect(afterVerify(db, capped, REPORTED)).toBe(false);
  const ev = listUndelivered(db, TH).find((e) => (e.payload as any)?.code === "VERIFY_LOOP_CAP");
  expect(ev?.payload).toMatchObject({ key: "verify-4" });
  expect(getItem(db, capped)).toMatchObject({ status: "blocked" });
  // docs has no fix yet: its verify may still loop (a third fix item of the goal, the first of docs).
  expect(afterVerify(db, failVerify(db, goalId, "verify-2"), REPORTED)).toBe(true);
  expect(byKey(db, goalId, "fix-3")).toMatchObject({ location: "docs" });
  expect(keysOf(db, goalId).filter((k) => k.startsWith("fix"))).toHaveLength(3);
});

test("single location: a revision-made verify never reaches a third fix item", () => {
  const p = approvedPlan([item("a")]);
  db = p.db;
  complete(db, p.goalId, "a");
  // verify-1 is running when the revision adds c.
  moveTaskTo(db, byKey(db, p.goalId, "verify-1").id, "ready");
  moveTaskTo(db, byKey(db, p.goalId, "verify-1").id, "running");
  expect(
    revisePlan(db, {
      planId: p.planId,
      baseVersion: 1,
      edit: edit({ add: [item("c")] }),
      reason: "more",
      env: ENV,
    }),
  ).toMatchObject({ ok: true });
  complete(db, p.goalId, "c");
  let verify = "verify-2";
  for (let loop = 1; loop <= MAX_FIX_LOOPS; loop++) {
    expect(afterVerify(db, failVerify(db, p.goalId, verify), REPORTED)).toBe(true);
    complete(db, p.goalId, `fix-${loop}`);
    verify = `verify-${2 + loop}`;
  }
  expect(afterVerify(db, failVerify(db, p.goalId, verify), REPORTED)).toBe(false);
  expect(keysOf(db, p.goalId).filter((k) => k.startsWith("fix-"))).toEqual([
    "fix-1:completed",
    "fix-2:completed",
  ]);
  expect(keysOf(db, p.goalId).some((k) => k.startsWith("fix-3"))).toBe(false);
});

test("revision before verify started: the not-started verify follows it in place (same key, new dependencies)", () => {
  const p = approvedPlan([item("a"), item("b", { dependsOn: ["a"] })]);
  db = p.db;
  expect(
    revisePlan(db, {
      planId: p.planId,
      baseVersion: 1,
      edit: edit({ add: [item("c", { dependsOn: ["b"] })] }),
      reason: "more",
      env: ENV,
    }),
  ).toMatchObject({ ok: true, status: "approved" });
  expect(keysOf(db, p.goalId).filter((k) => k.startsWith("verify"))).toEqual(["verify-1:pending"]);
  expect(byKey(db, p.goalId, "verify-1").dependsOn).toEqual(["a", "b", "c"]);
});

test("revision after verify-1 started: verify-2 covers the new items; the old verify's failure starts no fix loop", () => {
  const p = approvedPlan([item("a")]);
  db = p.db;
  complete(db, p.goalId, "a");
  const v1 = byKey(db, p.goalId, "verify-1").id;
  moveTaskTo(db, v1, "ready");
  moveTaskTo(db, v1, "running");
  expect(
    revisePlan(db, {
      planId: p.planId,
      baseVersion: 1,
      edit: edit({ add: [item("c")] }),
      reason: "more",
      env: ENV,
    }),
  ).toMatchObject({ ok: true });
  expect(keysOf(db, p.goalId).filter((k) => k.startsWith("verify"))).toEqual([
    "verify-1:running",
    "verify-2:pending",
  ]);
  expect(byKey(db, p.goalId, "verify-2")).toMatchObject({
    location: "repo",
    dependsOn: ["a", "c"],
  });
  // The old verify fails (it never saw `c`): it is superseded, no fix item.
  moveTaskTo(db, v1, "blocked");
  db.query("UPDATE owned_tasks SET result_kind = 'FAILED' WHERE id = ?").run(v1);
  expect(isHeld(getItem(db, v1)!)).toBe(true);
  expect(afterVerify(db, v1, REPORTED)).toBe(false);
  expect(getItem(db, v1)?.status).toBe("cancelled");
  expect(keysOf(db, p.goalId).some((k) => k.startsWith("fix"))).toBe(false);
  complete(db, p.goalId, "c");
  settleGoal(db, p.goalId);
  expect(status(p.goalId)).toBe("open"); // verify-2 still to run
  complete(db, p.goalId, "verify-2");
  settleGoal(db, p.goalId);
  expect(status(p.goalId)).toBe("completed"); // the newest verify decides
});

test("revision while the old verify is HELD (loop cap): the held verify is cancelled and verify-2 decides", () => {
  const p = approvedPlan([item("a")]);
  db = p.db;
  complete(db, p.goalId, "a");
  failVerify(db, p.goalId, "verify-1"); // held for the lead, no afterVerify call
  expect(
    revisePlan(db, {
      planId: p.planId,
      baseVersion: 1,
      edit: edit({ add: [item("c")] }),
      reason: "more",
      env: ENV,
    }),
  ).toMatchObject({ ok: true });
  expect(keysOf(db, p.goalId).filter((k) => k.startsWith("verify"))).toEqual([
    "verify-1:cancelled",
    "verify-2:pending",
  ]);
});

test("a revision that defers scope again drops a not-started verify (only the last wave verifies)", () => {
  const p = approvedPlan([item("a")]);
  db = p.db;
  expect(byKey(db, p.goalId, "verify-1").status).toBe("pending");
  expect(
    revisePlan(db, {
      planId: p.planId,
      baseVersion: 1,
      edit: edit({ add: [item("z", { deferredScope: true })] }),
      reason: "split",
      env: ENV,
    }),
  ).toMatchObject({ ok: true });
  expect(byKey(db, p.goalId, "verify-1").status).toBe("cancelled");
});
