import { expect, test } from "bun:test";
import { interruptRunningTurns } from "../src/storage/run-store";
import { listStages, upsertStage } from "../src/storage/stage-store";
import { makeEnv } from "./helpers";

test("upsert inserts, then updates in place; undefined fields keep their value; model persisted", () => {
  const { db } = makeEnv();
  upsertStage(db, {
    taskId: "t1",
    idx: 0,
    name: "plan",
    status: "running",
    model: "claude-sonnet-5-5",
    startedAt: 10,
  });
  upsertStage(db, { taskId: "t1", idx: 1, name: "exec", status: "running" });
  upsertStage(db, {
    taskId: "t1",
    idx: 0,
    name: "plan",
    status: "done",
    costUsd: 0.4,
    sessionId: "s1",
    endedAt: 20,
  });
  const rows = listStages(db, "t1");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    idx: 0,
    status: "done",
    model: "claude-sonnet-5-5", // kept from the first write
    costUsd: 0.4,
    sessionId: "s1",
    startedAt: 10,
    endedAt: 20,
  });
  expect(rows[1]).toMatchObject({ idx: 1, name: "exec", model: null });
  expect(listStages(db, "other")).toEqual([]);
});

test("interruptRunningTurns also interrupts running stages", () => {
  const { db } = makeEnv();
  upsertStage(db, { taskId: "t1", idx: 0, name: "plan", status: "done" });
  upsertStage(db, { taskId: "t1", idx: 1, name: "exec", status: "running" });
  interruptRunningTurns(db);
  expect(listStages(db, "t1").map((s) => s.status)).toEqual(["done", "interrupted"]);
});
