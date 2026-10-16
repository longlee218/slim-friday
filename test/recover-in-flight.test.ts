import { expect, test } from "bun:test";
import { recoverInFlight } from "../src/orchestrator/engine/recover-in-flight";
import { getOwnedTask, insertOwnedTask, linkTurn } from "../src/storage/owned-task-store";
import { insertTurn } from "../src/storage/run-store";
import { appendEvent, listUndelivered } from "../src/storage/thread-event-store";
import { makeEnv } from "./helpers";

/* Boot recovery: a task `running` with no process becomes ONE recovered_after_restart event, not a silent failure. */

test("running task at boot -> one recovered_after_restart event, task waits for the owner (not failed), stale claim released", () => {
  const env = makeEnv();
  insertOwnedTask(env.db, {
    id: "rc-task",
    threadId: "rc-th",
    ownerRole: "developer",
    status: "running",
    scope: "add b.txt",
    correlationId: "c",
  });
  insertTurn(env.db, {
    id: "rc-turn",
    threadId: "rc-th",
    source: "t",
    location: "r",
    role: "developer",
  });
  linkTurn(env.db, "rc-turn", "rc-task");
  // An event claimed by a consumer turn that is still `running` when the process died.
  insertTurn(env.db, {
    id: "rc-lead",
    threadId: "rc-th",
    source: "t",
    location: "r",
    role: "developer",
  });
  appendEvent(env.db, { id: "rc-e1", threadId: "rc-th", kind: "result", payload: {} });
  env.db.query("UPDATE thread_events SET claimed_by = ? WHERE id = ?").run("rc-lead", "rc-e1");

  const report = recoverInFlight(env.db);

  expect(report.recovered).toEqual(["rc-task"]);
  expect(report.unclaimed).toBe(1);
  expect(report.threads).toEqual(["rc-th"]);
  expect(getOwnedTask(env.db, "rc-task")?.status).toBe("waiting_user");
  const events = listUndelivered(env.db, "rc-th");
  const rec = events.filter((e) => e.kind === "recovered_after_restart");
  expect(rec).toHaveLength(1);
  expect(rec[0]!.taskId).toBe("rc-task");
  expect(rec[0]!.payload).toEqual({ taskId: "rc-task", excerpt: "add b.txt" });
  expect(events.find((e) => e.id === "rc-e1")?.redelivered).toBe(true);

  // A second boot finds no running task: nothing is appended again.
  expect(recoverInFlight(env.db).recovered).toEqual([]);
  expect(
    listUndelivered(env.db, "rc-th").filter((e) => e.kind === "recovered_after_restart"),
  ).toHaveLength(1);
});

test("M3: interrupt and events are one transaction: a failing append rolls the interrupt back (nothing half-done)", () => {
  const env = makeEnv();
  insertOwnedTask(env.db, {
    id: "rt-task",
    threadId: "rt-th",
    ownerRole: "developer",
    status: "running",
    scope: "s",
    correlationId: "c",
  });
  insertTurn(env.db, {
    id: "rt-turn",
    threadId: "rt-th",
    source: "t",
    location: "r",
    role: "developer",
  });
  linkTurn(env.db, "rt-turn", "rt-task");
  env.db.run("DROP TABLE thread_events"); // the append will throw
  expect(() => recoverInFlight(env.db)).toThrow();
  expect(getOwnedTask(env.db, "rt-task")?.status).toBe("running"); // rolled back: the next boot still sees it
  expect(env.db.query("SELECT status FROM turns WHERE id = 'rt-turn'").get()).toEqual({
    status: "running",
  });
});
