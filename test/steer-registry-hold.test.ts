import { expect, test } from "bun:test";
import { createSteerRegistry } from "../src/orchestrator/turns/steer-registry";
import type { SteerSink } from "../src/runtime/run-input-channel";
import { listRunMessages } from "../src/storage/run-message-store";
import { finishTurn, insertTurn } from "../src/storage/run-store";
import { makeEnv } from "./helpers";

/* Steer registry while a streaming run is starting (Rev 11 review, H-c): a steer is held until the run registers its input. */

const TH = { threadId: "th" };
const dev = (db: ReturnType<typeof makeEnv>["db"], id = "t1") =>
  insertTurn(db, { id, threadId: "th", source: "t", location: "r", role: "dev", brief: "add b" });

/** A sink that records what is pushed. */
const sink = (pushed: string[]): SteerSink => ({
  push: (text) => {
    pushed.push(text);
    return "queued";
  },
});

test("while a streaming run is starting a steer is HELD and goes into its input, in order; its row learns the task", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  dev(env.db);
  expect(reg.canSteer("th")).toBe(false); // no sink right now ...
  expect(reg.canTake("th")).toBe(true); // ... but a dev task is a streaming run: a message can wait
  expect(reg.steer(TH, "first").result).toBe("held");
  expect(reg.steer(TH, "second").result).toBe("held");
  const pushed: string[] = [];
  reg.hook("th").register(sink(pushed), { runId: "r1", turnId: "t1" }); // the run opens its input
  expect(pushed).toEqual(["first", "second"]);
  expect(listRunMessages(env.db, "th").map((r) => [r.content, r.status, r.taskId])).toEqual([
    ["first", "pending", "t1"],
    ["second", "pending", "t1"],
  ]);
  expect(reg.undeliveredNotice("th")).toBe(""); // nothing left over
});

test("held steers that no run ever took are never silent: dropped, and the notice lists them; nothing leaks to a later task", () => {
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

test("no running task, or a role that reads no steers: nothing is held (none)", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  expect(reg.canTake("th")).toBe(false);
  expect(reg.steer(TH, "x").result).toBe("none");
  insertTurn(env.db, { id: "a1", threadId: "th", source: "t", location: "r", role: "assistant" });
  expect(reg.canTake("th")).toBe(false); // the assistant reads no steers
  expect(reg.steer(TH, "y").result).toBe("none");
  expect(listRunMessages(env.db, "th").map((r) => r.status)).toEqual(["skipped", "skipped"]);
  finishTurn(env.db, "a1", "done");
});

test("a steer into a registered run is queued with the run's id and the task's id; the plan approval is no state of its own", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  dev(env.db);
  const pushed: string[] = [];
  reg.hook("th").register(sink(pushed), { runId: "r1", turnId: "t1" });
  expect(reg.steer(TH, "a")).toEqual({ result: "queued" });
  expect(reg.steer(TH, "b")).toEqual({ result: "queued" });
  expect(pushed).toEqual(["a", "b"]);
  expect(listRunMessages(env.db, "th").map((r) => [r.runId, r.taskId])).toEqual([
    ["r1", "t1"],
    ["r1", "t1"],
  ]);
});
