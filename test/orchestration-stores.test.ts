import { expect, test } from "bun:test";
import { appendEffect, effectsOfGoal } from "../src/storage/effect-log-store";
import {
  bumpDispatch,
  childrenOf,
  getItem,
  goalOf,
  setTaskResult,
} from "../src/storage/owned-item-store";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { getSession, setSession } from "../src/storage/session-store";
import { bumpCycle } from "../src/storage/thread-summary-store";
import {
  casPlanStatus,
  getPlan,
  insertPlanVersion,
  latestPlan,
} from "../src/storage/work-plan-store";
import { makeEnv } from "./helpers";

const base = { threadId: "th", ownerRole: "developer", correlationId: "c" };

test("owned items: children in order, goalOf, deps parsed, dispatch counter, result", () => {
  const { db } = makeEnv();
  insertOwnedTask(db, { ...base, id: "g", status: "open", scope: "goal" });
  insertOwnedTask(db, {
    ...base,
    id: "i1",
    status: "pending",
    scope: "a",
    parentId: "g",
    itemKey: "design",
  });
  insertOwnedTask(db, {
    ...base,
    id: "i2",
    status: "pending",
    scope: "b",
    parentId: "g",
    itemKey: "build",
    dependsOn: ["design"],
  });
  expect(childrenOf(db, "g").map((c) => [c.itemKey, c.dependsOn])).toEqual([
    ["design", []],
    ["build", ["design"]],
  ]);
  expect(goalOf(db, "i2")).toBe("g");
  expect(goalOf(db, "g")).toBeUndefined();
  expect(bumpDispatch(db, "i1")).toBe(1);
  expect(bumpDispatch(db, "i1")).toBe(2);
  setTaskResult(db, "i1", { excerpt: "e", kind: "COMPLETED" });
  expect(getItem(db, "i1")).toMatchObject({
    resultExcerpt: "e",
    resultKind: "COMPLETED",
  });
});

test("work plans: versions count up, CAS status moves once", () => {
  const { db } = makeEnv();
  const p = {
    id: "p",
    goalId: "g",
    strategy: "s",
    objective: "o",
    body: "b",
    acceptance: "[]",
    envelope: "{}",
    budgetUsd: 1,
    effects: null,
    reason: null,
  };
  expect(insertPlanVersion(db, p).version).toBe(1);
  expect(insertPlanVersion(db, p).version).toBe(2);
  expect(latestPlan(db, "p")?.version).toBe(2);
  expect(casPlanStatus(db, "p", 2, "draft", "approved")).toBe(true);
  expect(casPlanStatus(db, "p", 2, "draft", "rejected")).toBe(false);
  expect(getPlan(db, "p", 2)?.status).toBe("approved");
  expect(getPlan(db, "p", 2)?.approvedAt).not.toBeNull();
});

test("effect log: idempotent append, listed by goal", () => {
  const { db } = makeEnv();
  const e = {
    id: "e1",
    threadId: "th",
    goalId: "g",
    tool: "Bash",
    scope: "rm tmp",
    grantedBy: "owner",
    result: "ok",
  };
  expect(appendEffect(db, e)).toBe(true);
  expect(appendEffect(db, e)).toBe(false);
  expect(effectsOfGoal(db, "g")).toHaveLength(1);
});

test("sessions: model + kind stored; a new row after a roll takes the thread's cycle as generation", () => {
  const { db } = makeEnv();
  setSession(db, {
    threadId: "th",
    sessionId: "s1",
    location: "r",
    cwd: "/r",
    model: "m",
    kind: "teammate",
  });
  expect(getSession(db, "th")).toMatchObject({ model: "m", kind: "teammate", generation: 0 });
  db.query("DELETE FROM sessions").run();
  bumpCycle(db, "th", "ws");
  setSession(db, { threadId: "th", sessionId: "s2", location: "r", cwd: "/r" });
  expect(getSession(db, "th")).toMatchObject({ generation: 1, kind: "role" });
});

test("sessions: an update without kind / model keeps the stored ones", () => {
  const { db } = makeEnv();
  setSession(db, {
    threadId: "th",
    sessionId: "s1",
    location: "r",
    cwd: "/r",
    model: "m",
    kind: "teammate",
  });
  setSession(db, { threadId: "th", sessionId: "s2", location: "r", cwd: "/r" });
  expect(getSession(db, "th")).toMatchObject({ session_id: "s2", model: "m", kind: "teammate" });
});

test("owned items: an item key is unique within its goal, free across goals and for goals", () => {
  const { db } = makeEnv();
  const item = (id: string, parentId: string) =>
    insertOwnedTask(db, { ...base, id, status: "pending", scope: "s", parentId, itemKey: "main" });
  item("a", "g1");
  expect(() => item("b", "g1")).toThrow();
  item("c", "g2");
  insertOwnedTask(db, { ...base, id: "g1", status: "open", scope: "s" });
  insertOwnedTask(db, { ...base, id: "g2", status: "open", scope: "s" });
});
