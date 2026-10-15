import { expect, test } from "bun:test";
import { openDb } from "../src/storage/db";
import {
  activeOwnedTask,
  casUpdateTask,
  getOwnedTask,
  insertOwnedTask,
  linkTurn,
  ownedTaskOfTurn,
  reconcileRunningTasks,
} from "../src/storage/owned-task-store";
import { insertTurn, interruptRunningTurns, setTurnSession } from "../src/storage/run-store";
import type { TaskState } from "../src/tasks/task-contracts";
import { makeEnv } from "./helpers";

const mk = (
  db: ReturnType<typeof makeEnv>["db"],
  id: string,
  status: TaskState["status"] = "open",
) =>
  insertOwnedTask(db, {
    id,
    threadId: "th",
    ownerRole: "developer",
    status,
    scope: "s",
    correlationId: "c",
  });

test("insert/get round trip; version starts at 0", () => {
  const { db } = makeEnv();
  mk(db, "a");
  expect(getOwnedTask(db, "a")).toMatchObject({
    taskId: "a",
    ownerAgentId: "developer",
    status: "open",
    scope: "s",
    version: 0,
    correlationId: "c",
  });
  expect(getOwnedTask(db, "nope")).toBeUndefined();
});

test("CAS: matching version applies and bumps; a stale version changes nothing", () => {
  const { db } = makeEnv();
  mk(db, "a");
  expect(casUpdateTask(db, "a", 0, { status: "running" })).toBe(true);
  expect(casUpdateTask(db, "a", 0, { status: "failed" })).toBe(false);
  expect(getOwnedTask(db, "a")).toMatchObject({
    status: "running",
    version: 1,
    ownerAgentId: "developer",
  });
  expect(casUpdateTask(db, "a", 1, { ownerRole: "other" })).toBe(true);
  expect(getOwnedTask(db, "a")).toMatchObject({
    status: "running",
    version: 2,
    ownerAgentId: "other",
  });
});

test("active task = newest live one; terminal tasks are never the focus", async () => {
  const { db } = makeEnv();
  mk(db, "old", "waiting_user");
  await Bun.sleep(3);
  mk(db, "new", "running");
  await Bun.sleep(3);
  mk(db, "done", "completed");
  expect(activeOwnedTask(db, "th")?.taskId).toBe("new");
  expect(activeOwnedTask(db, "other-thread")).toBeUndefined();
});

test("link + lookup of a turn's task", () => {
  const { db } = makeEnv();
  mk(db, "a");
  insertTurn(db, { id: "t1", threadId: "th", source: "x", location: "*", role: "developer" });
  expect(ownedTaskOfTurn(db, "t1")).toBeUndefined();
  linkTurn(db, "t1", "a");
  setTurnSession(db, "t1", "sess", "/cwd");
  expect(ownedTaskOfTurn(db, "t1")).toBe("a");
});

test("reconcile: running tasks wait for the owner, others stay; interruptRunningTurns runs it", () => {
  const { db } = makeEnv();
  mk(db, "r", "running");
  mk(db, "o", "open");
  reconcileRunningTasks(db);
  expect(getOwnedTask(db, "r")?.status).toBe("waiting_user");
  expect(getOwnedTask(db, "o")?.status).toBe("open");
  casUpdateTask(db, "r", 1, { status: "running" });
  interruptRunningTurns(db);
  expect(getOwnedTask(db, "r")?.status).toBe("waiting_user");
});

test("a task and its owner survive a db reopen", () => {
  const { db, paths } = makeEnv();
  mk(db, "a", "waiting_user");
  db.close();
  const again = openDb(paths.dbFile);
  expect(getOwnedTask(again, "a")).toMatchObject({
    ownerAgentId: "developer",
    status: "waiting_user",
  });
});
