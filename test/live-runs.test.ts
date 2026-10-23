import { expect, test } from "bun:test";
import {
  abortAllRuns,
  abortThreadRuns,
  attachSink,
  liveRunOf,
  liveRunsOf,
  pendingRuns,
  registerRun,
  runOfTask,
  steerRunOfThread,
} from "../src/orchestrator/run/live-runs";

/* The one live-run registry: register / settle, thread index, liveRunOf, abort by thread, steer sink, error path. */

const worker = (taskId: string, threadId: string) => {
  const ac = new AbortController();
  const settle = registerRun({
    kind: "worker",
    taskId,
    threadId,
    turnId: `turn-${taskId}`,
    role: "developer",
    ac,
  });
  return { ac, settle };
};
const teammate = (threadId: string) => {
  const ac = new AbortController();
  return { ac, settle: registerRun({ kind: "teammate", threadId, role: "chief-of-staff", ac }) };
};

test("register / settle: the run is listed while it runs; settle is idempotent and resolves its promise", async () => {
  const a = worker("tr-a", "th-1");
  expect(liveRunsOf("th-1").map((h) => h.taskId)).toEqual(["tr-a"]);
  const before = pendingRuns().length;
  const done = pendingRuns().at(-1) as Promise<void>; // this run's promise (the newest)
  a.settle();
  a.settle(); // twice: no effect, no throw
  await done;
  expect(pendingRuns().length).toBe(before - 1);
  expect(liveRunsOf("th-1")).toEqual([]);
});

test("a thread keeps several runs; liveRunOf = teammate run first, else the newest worker run", () => {
  const a = worker("tr-b1", "th-2");
  const b = worker("tr-b2", "th-2");
  const other = worker("tr-b3", "th-3");
  expect(liveRunsOf("th-2").map((h) => h.taskId)).toEqual(["tr-b1", "tr-b2"]);
  expect(liveRunOf("th-2")).toBe(b.ac); // newest worker run
  const fg = teammate("th-2");
  expect(liveRunOf("th-2")).toBe(fg.ac); // teammate wins
  expect(liveRunOf("th-none")).toBeUndefined();
  for (const r of [a, b, other, fg]) r.settle();
});

test("abortThreadRuns aborts only that thread's runs (teammate included); abortAllRuns aborts all", () => {
  const a = worker("tr-c1", "th-4");
  const b = worker("tr-c2", "th-4");
  const l = teammate("th-4");
  const c = worker("tr-c3", "th-5");
  expect(abortThreadRuns("th-4")).toHaveLength(3);
  expect([a, b, l, c].map((r) => r.ac.signal.aborted)).toEqual([true, true, true, false]);
  expect(pendingRuns().length).toBeGreaterThanOrEqual(4);
  abortAllRuns();
  expect(c.ac.signal.aborted).toBe(true);
  for (const r of [a, b, l, c]) r.settle();
});

test("a continuation registered under the same task id is not removed by the older run's settle", () => {
  const first = worker("tr-d", "th-6");
  const second = worker("tr-d", "th-6");
  first.settle();
  expect(liveRunsOf("th-6")).toHaveLength(1);
  second.settle();
  expect(liveRunsOf("th-6")).toHaveLength(0);
});

test("registering a task id that is already live aborts the old run before replacing it", () => {
  const first = worker("tr-e", "th-7");
  const second = worker("tr-e", "th-7");
  expect(first.ac.signal.aborted).toBe(true);
  expect(second.ac.signal.aborted).toBe(false);
  expect(liveRunsOf("th-7")).toHaveLength(1);
  first.settle();
  second.settle();
});

test("runOfTask finds a worker by task id or by turn id", () => {
  const a = worker("tr-f", "th-8");
  expect(runOfTask("tr-f")?.ac).toBe(a.ac);
  expect(runOfTask("turn-tr-f")?.ac).toBe(a.ac);
  expect(runOfTask("nope")).toBeUndefined();
  a.settle();
});

test("a sink attaches to its live run by turn id and detaches; an unregistered turn gets none", () => {
  const a = worker("tr-g", "th-9");
  const sink = { push: () => "queued" as const };
  const detach = attachSink("turn-tr-g", sink, { runId: "r", turnId: "turn-tr-g" });
  expect(runOfTask("tr-g")?.steer?.sink).toBe(sink);
  expect(steerRunOfThread("th-9")?.runId).toBe("r");
  detach();
  expect(runOfTask("tr-g")?.steer).toBeUndefined();
  attachSink("turn-unknown", sink, { runId: "r2", turnId: "turn-unknown" })(); // no entry: no throw
  a.settle();
});

test("a run that errors still unregisters when its owner settles in `finally`", async () => {
  const ac = new AbortController();
  const run = async () => {
    const settle = registerRun({
      kind: "worker",
      taskId: "tr-h",
      threadId: "th-10",
      role: "developer",
      ac,
    });
    try {
      expect(liveRunsOf("th-10")).toHaveLength(1);
      throw new Error("boom");
    } finally {
      settle();
    }
  };
  await expect(run()).rejects.toThrow("boom");
  expect(liveRunsOf("th-10")).toHaveLength(0);
  expect(runOfTask("tr-h")).toBeUndefined();
});
