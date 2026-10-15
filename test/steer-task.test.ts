import { expect, test } from "bun:test";
import { registerTaskRun } from "../src/orchestrator/engine/task-runs";
import { createSteerRegistry } from "../src/orchestrator/turns/steer-registry";
import type { SteerSink } from "../src/runtime/run-input-channel";
import { insertOwnedTask, linkTurn } from "../src/storage/owned-task-store";
import { insertTurn } from "../src/storage/run-store";
import { makeEnv } from "./helpers";

/* Steer registry keyed by task: two tasks of one thread are steered independently. */

const sink = (pushed: string[]): SteerSink => ({
  push: (text) => {
    pushed.push(text);
    return "queued";
  },
});

/** A running dev turn linked to its own owned task. */
function devTask(env: ReturnType<typeof makeEnv>, taskId: string, turnId: string) {
  insertOwnedTask(env.db, {
    id: taskId,
    threadId: "th",
    ownerRole: "developer",
    status: "running",
    scope: "s",
    correlationId: "c",
  });
  insertTurn(env.db, { id: turnId, threadId: "th", source: "t", location: "r", role: "developer" });
  linkTurn(env.db, turnId, taskId);
}

test("steerTask reaches only its task; steer(thread) goes to the newest; liveTasksOf lists both", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  devTask(env, "task-a", "turn-a");
  devTask(env, "task-b", "turn-b");
  const a: string[] = [];
  const b: string[] = [];
  reg.hook("th").register(sink(a), { runId: "ra", turnId: "turn-a" });
  reg.hook("th").register(sink(b), { runId: "rb", turnId: "turn-b" });
  expect(reg.liveTasksOf("th")).toEqual(["task-a", "task-b"]);

  expect(reg.steerTask("task-a", "for a").result).toBe("queued");
  expect(reg.steerTask("task-b", "for b").result).toBe("queued");
  expect(reg.steer({ threadId: "th" }, "newest").result).toBe("queued");
  expect(a).toEqual(["for a"]);
  expect(b).toEqual(["for b", "newest"]);
  expect(reg.steerTask("task-unknown", "x").result).toBe("none");
});

test("a steer held for one task goes only into that task's input when it registers", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  devTask(env, "task-c", "turn-c");
  devTask(env, "task-d", "turn-d");
  expect(reg.steerTask("task-c", "wait for c").result).toBe("held");
  const c: string[] = [];
  const d: string[] = [];
  reg.hook("th").register(sink(d), { runId: "rd", turnId: "turn-d" });
  expect(d).toEqual([]); // d's input does not receive c's steer
  reg.hook("th").register(sink(c), { runId: "rc", turnId: "turn-c" });
  expect(c).toEqual(["wait for c"]);
});

test("H1: undeliveredNotice keeps the held steers of a live detached task, drops those of a task with no live run", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  devTask(env, "task-e", "turn-e");
  expect(reg.steerTask("task-e", "keep me").result).toBe("held");
  const settle = registerTaskRun("task-e", {
    threadId: "th",
    turnId: "turn-e",
    role: "developer",
    ac: new AbortController(),
  });
  expect(reg.undeliveredNotice("th")).toBe(""); // live detached run: the steer survives
  const got: string[] = [];
  reg.hook("th").register(sink(got), { runId: "re", turnId: "turn-e" });
  expect(got).toEqual(["keep me"]);
  settle();
  expect(reg.steerTask("task-e", "orphan").result).toBe("queued"); // sink is registered
  devTask(env, "task-f", "turn-f");
  reg.steerTask("task-f", "lost");
  expect(reg.undeliveredNotice("th")).toContain("lost"); // no live run: dropped and told
});

test("H2: steer(thread) goes to the running task's own sink, never to an older task's (A registered, B newer still starting)", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  devTask(env, "task-g", "turn-g");
  const a: string[] = [];
  reg.hook("th").register(sink(a), { runId: "rg", turnId: "turn-g" });
  devTask(env, "task-h", "turn-h"); // newer, its run has not registered yet
  expect(reg.steer({ threadId: "th" }, "for the newest").result).toBe("held");
  expect(a).toEqual([]);
  const b: string[] = [];
  reg.hook("th").register(sink(b), { runId: "rh", turnId: "turn-h" });
  expect(b).toEqual(["for the newest"]);
  expect(a).toEqual([]);
});

test("L1: steerTask accepts a turn id and resolves it to its task", () => {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  devTask(env, "task-i", "turn-i");
  const got: string[] = [];
  reg.hook("th").register(sink(got), { runId: "ri", turnId: "turn-i" });
  expect(reg.steerTask("turn-i", "by turn id").result).toBe("queued");
  expect(got).toEqual(["by turn id"]);
});
