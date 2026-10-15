import { expect, test } from "bun:test";
import {
  abortAllTaskRuns,
  abortThreadTasks,
  liveRunOf,
  liveTasksOf,
  pendingTaskRuns,
  registerTaskRun,
  taskRunSettled,
} from "../src/orchestrator/engine/task-runs";

/* Registry of live task runs: register / settle, thread index, liveRunOf, abort by thread. */

const reg = (taskId: string, threadId: string) => {
  const ac = new AbortController();
  const settle = registerTaskRun(taskId, {
    threadId,
    turnId: `turn-${taskId}`,
    role: "developer",
    ac,
  });
  return { ac, settle };
};

test("register / settle: the run is listed while it runs; settle is idempotent and resolves its promise", async () => {
  const a = reg("tr-a", "th-1");
  expect(liveTasksOf("th-1").map((h) => h.taskId)).toEqual(["tr-a"]);
  const done = taskRunSettled(a.ac)!;
  a.settle();
  a.settle(); // twice: no effect, no throw
  await done;
  expect(liveTasksOf("th-1")).toEqual([]);
});

test("a thread keeps several task runs; liveRunOf = foreground run first, else the newest task run", () => {
  const a = reg("tr-b1", "th-2");
  const b = reg("tr-b2", "th-2");
  const other = reg("tr-b3", "th-3");
  expect(liveTasksOf("th-2").map((h) => h.taskId)).toEqual(["tr-b1", "tr-b2"]);
  const active = new Map<string, AbortController>();
  expect(liveRunOf(active, "th-2")).toBe(b.ac); // newest task run
  const fg = new AbortController();
  active.set("th-2", fg);
  expect(liveRunOf(active, "th-2")).toBe(fg); // foreground wins
  expect(liveRunOf(active, "th-none")).toBeUndefined();
  for (const r of [a, b, other]) r.settle();
});

test("abortThreadTasks aborts only that thread's runs; abortAllTaskRuns aborts all; pending lists live runs", () => {
  const a = reg("tr-c1", "th-4");
  const b = reg("tr-c2", "th-4");
  const c = reg("tr-c3", "th-5");
  expect(abortThreadTasks("th-4").map((h) => h.taskId)).toEqual(["tr-c1", "tr-c2"]);
  expect([a.ac.signal.aborted, b.ac.signal.aborted, c.ac.signal.aborted]).toEqual([
    true,
    true,
    false,
  ]);
  expect(pendingTaskRuns().length).toBeGreaterThanOrEqual(3);
  abortAllTaskRuns();
  expect(c.ac.signal.aborted).toBe(true);
  for (const r of [a, b, c]) r.settle();
});

test("a continuation registered under the same task id is not removed by the older run's settle", () => {
  const first = reg("tr-d", "th-6");
  const second = reg("tr-d", "th-6");
  first.settle();
  expect(liveTasksOf("th-6")).toHaveLength(1);
  second.settle();
  expect(liveTasksOf("th-6")).toHaveLength(0);
});

test("registering a task id that is already live aborts the old run before replacing it", () => {
  const first = reg("tr-e", "th-7");
  const second = reg("tr-e", "th-7");
  expect(first.ac.signal.aborted).toBe(true);
  expect(second.ac.signal.aborted).toBe(false);
  expect(liveTasksOf("th-7")).toHaveLength(1);
  first.settle();
  second.settle();
});
