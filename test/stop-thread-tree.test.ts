import { expect, test } from "bun:test";
import { registerTaskRun } from "../src/orchestrator/engine/task-runs";
import { appendEvent, listUndelivered } from "../src/orchestrator/events/event-store";
import { stopThread } from "../src/orchestrator/turns/turn-stop";
import { getOwnedTask, insertOwnedTask } from "../src/storage/owned-task-store";
import { insertTurn } from "../src/storage/run-store";
import { makeEnv } from "./helpers";

/* `/stop` takes the whole tree of the thread down: lead run, queued lead inputs, every task run, unstarted `start` events. */

const task = (env: ReturnType<typeof makeEnv>, id: string, threadId: string, status = "running") =>
  insertOwnedTask(env.db, {
    id,
    threadId,
    ownerRole: "developer",
    status: status as never,
    scope: "s",
    correlationId: "c",
  });

test("/stop aborts the lead run + both task runs, clears the lead queue, cancels live tasks and closes start events", () => {
  const env = makeEnv();
  task(env, "st-t1", "st-th");
  task(env, "st-t2", "st-th");
  task(env, "st-done", "st-th", "completed"); // an ended task keeps its status
  task(env, "st-other", "st-other-th");
  const lead = new AbortController();
  const runs = ["st-t1", "st-t2", "st-other"].map((taskId) => {
    const ac = new AbortController();
    const settle = registerTaskRun(taskId, {
      threadId: taskId === "st-other" ? "st-other-th" : "st-th",
      turnId: `turn-${taskId}`,
      role: "developer",
      ac,
    });
    return { taskId, ac, settle };
  });
  appendEvent(env.db, { id: "e-start", threadId: "st-th", kind: "start", payload: {} });
  appendEvent(env.db, { id: "e-res", threadId: "st-th", kind: "result", payload: {} });
  const stopped: string[] = [];

  const notice = stopThread(env.db, "st-th", "en", lead, {
    stop: (t) => void stopped.push(t),
    busy: () => false,
  });

  expect(notice.length).toBeGreaterThan(0);
  expect(lead.signal.aborted).toBe(true);
  expect(stopped).toEqual(["st-th"]); // queued lead inputs dropped
  expect(runs.map((r) => r.ac.signal.aborted)).toEqual([true, true, false]); // other thread untouched
  expect(getOwnedTask(env.db, "st-t1")?.status).toBe("cancelled");
  expect(getOwnedTask(env.db, "st-t2")?.status).toBe("cancelled");
  expect(getOwnedTask(env.db, "st-done")?.status).toBe("completed");
  expect(getOwnedTask(env.db, "st-other")?.status).toBe("running");
  expect(listUndelivered(env.db, "st-th").map((e) => e.kind)).toEqual(["result"]); // start closed, result kept
  for (const r of runs) r.settle();
});

test("L4: a start event claimed by a live consumer is kept; an unclaimed one is closed", () => {
  const env = makeEnv();
  insertTurn(env.db, {
    id: "lc-turn",
    threadId: "lc-th",
    source: "t",
    location: "r",
    role: "developer",
  }); // running
  appendEvent(env.db, { id: "lc-1", threadId: "lc-th", kind: "start", payload: {} });
  // lc-1 is claimed by the consumer turn that is still running
  env.db.query("UPDATE thread_events SET claimed_by = ? WHERE id = ?").run("lc-turn", "lc-1");
  appendEvent(env.db, { id: "lc-2", threadId: "lc-th", kind: "start", payload: {} });
  stopThread(env.db, "lc-th", "en", new AbortController());
  expect(listUndelivered(env.db, "lc-th").map((e) => e.id)).toEqual(["lc-1"]);
});
