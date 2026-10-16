import { expect, test } from "bun:test";
import { createSteerRegistry } from "../src/orchestrator/turns/steer-registry";
import type { SteerSink } from "../src/runtime/run-input-channel";
import { listRunMessages } from "../src/storage/run-message-store";
import { finishTurn, insertTurn } from "../src/storage/run-store";
import { makeEnv } from "./helpers";

/* Steer registry while a streaming run is starting (Rev 11 review, H-c): a steer is held until the run registers its input. */

const dev = (db: ReturnType<typeof makeEnv>["db"], id = "t1") =>
  insertTurn(db, {
    id,
    threadId: "th",
    source: "t",
    location: "r",
    role: "developer",
    brief: "add b",
  });

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
  expect(reg.steerTask("t1", "first").result).toBe("held");
  expect(reg.steerTask("t1", "second").result).toBe("held");
  const pushed: string[] = [];
  reg.hook("th").register(sink(pushed), { runId: "r1", turnId: "t1" }); // the run opens its input
  expect(pushed).toEqual(["first", "second"]);
  expect(listRunMessages(env.db, "th").map((r) => [r.content, r.status, r.taskId])).toEqual([
    ["first", "pending", "t1"],
    ["second", "pending", "t1"],
  ]);
});

test("no running task, or a role that reads no steers: nothing is held (none)", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  expect(reg.steerTask("t0", "x").result).toBe("none"); // no such task
  insertTurn(env.db, { id: "a1", threadId: "th", source: "t", location: "r", role: "lead" });
  expect(reg.steerTask("a1", "y").result).toBe("none");
  expect(listRunMessages(env.db, "th").map((r) => r.status)).toEqual(["skipped"]);
  finishTurn(env.db, "a1", "done");
});

test("a steer into a registered run is queued with the run's id and the task's id; the plan approval is no state of its own", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  dev(env.db);
  const pushed: string[] = [];
  reg.hook("th").register(sink(pushed), { runId: "r1", turnId: "t1" });
  expect(reg.steerTask("t1", "a")).toEqual({ result: "queued" });
  expect(reg.steerTask("t1", "b")).toEqual({ result: "queued" });
  expect(pushed).toEqual(["a", "b"]);
  expect(listRunMessages(env.db, "th").map((r) => [r.runId, r.taskId])).toEqual([
    ["r1", "t1"],
    ["r1", "t1"],
  ]);
});
