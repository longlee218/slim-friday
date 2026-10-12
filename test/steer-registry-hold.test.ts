import { expect, test } from "bun:test";
import { createSteerRegistry } from "../src/orchestrator/turns/steer-registry";
import type { SteerSink } from "../src/runtime/run-input-channel";
import { PLAN_NOT_REAPPROVED, threadLedger } from "../src/storage/ledger-store";
import { listRunMessages } from "../src/storage/run-message-store";
import { finishTask, insertTask } from "../src/storage/run-store";
import { upsertStage } from "../src/storage/stage-store";
import { makeEnv } from "./helpers";

/* Steer registry between streaming stages (Rev 11 review, H-c) and after an approved plan (M-a). */

const TH = { threadId: "th" };
const dev = (db: ReturnType<typeof makeEnv>["db"], id = "t1") =>
  insertTask(db, { id, threadId: "th", source: "t", repo: "r", role: "dev", brief: "add b" });

/** A sink that records what is pushed. */
const sink = (pushed: string[]): SteerSink => ({
  push: (text) => {
    pushed.push(text);
    return "queued";
  },
});

test("between streaming stages a steer is HELD and goes into the next stage's input, in order; its row learns the task", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  dev(env.db);
  expect(reg.canSteer("th")).toBe(false); // no sink right now ...
  expect(reg.canTake("th")).toBe(true); // ... but a dev task has streaming stages: a message can wait
  expect(reg.steer(TH, "first").result).toBe("held");
  expect(reg.steer(TH, "second").result).toBe("held");
  const pushed: string[] = [];
  reg.hook("th").register(sink(pushed), { runId: "r1", turnId: "t1" }); // the next streaming stage starts
  expect(pushed).toEqual(["first", "second"]);
  expect(listRunMessages(env.db, "th").map((r) => [r.content, r.status, r.taskId])).toEqual([
    ["first", "pending", "t1"],
    ["second", "pending", "t1"],
  ]);
  expect(reg.undeliveredNotice("th")).toBe(""); // nothing left over
});

test("held steers that no stage ever took are never silent: dropped, and the notice lists them; nothing leaks to a later task", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  dev(env.db);
  reg.steer(TH, "orphan");
  const notice = reg.undeliveredNotice("th");
  expect(notice).toContain("Not delivered");
  expect(notice).toContain("orphan");
  expect(listRunMessages(env.db, "th")[0]?.status).toBe("dropped");
  const pushed: string[] = [];
  reg.hook("th").register(sink(pushed), { runId: "r2", turnId: "t2" });
  expect(pushed).toEqual([]); // the next task starts clean
});

test("no running task, or one without a streaming stage: nothing is held (none)", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  expect(reg.canTake("th")).toBe(false);
  expect(reg.steer(TH, "x").result).toBe("none");
  insertTask(env.db, { id: "a1", threadId: "th", source: "t", repo: "r", role: "assistant" });
  expect(reg.canTake("th")).toBe(false); // the assistant's qa stage reads no steers
  expect(reg.steer(TH, "y").result).toBe("none");
  expect(listRunMessages(env.db, "th").map((r) => r.status)).toEqual(["skipped", "skipped"]);
  finishTask(env.db, "a1", "done");
});

test("M-a: a steer into work after the approved plan says so, and the task ledger carries the line", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  dev(env.db);
  const pushed: string[] = [];
  reg.hook("th").register(sink(pushed), { runId: "r1", turnId: "t1" });
  // plan stage still running: no warning
  expect(reg.steer(TH, "a")).toEqual({ result: "queued", afterPlan: false });
  expect(threadLedger(env.db, "th")).not.toContain(PLAN_NOT_REAPPROVED);
  // the plan was approved (the engine writes verdict `approved` on the plan stage row)
  upsertStage(env.db, { taskId: "t1", idx: 0, name: "plan", status: "done", verdict: "approved" });
  expect(reg.steer(TH, "b")).toEqual({ result: "queued", afterPlan: true });
  expect(threadLedger(env.db, "th")).toContain(`  ${PLAN_NOT_REAPPROVED}`);
  expect(listRunMessages(env.db, "th").map((r) => r.afterPlan)).toEqual([0, 1]);
});
