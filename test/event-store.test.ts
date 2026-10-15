import { expect, test } from "bun:test";
import {
  appendEvent,
  claimBatch,
  listUndelivered,
  markDelivered,
  unclaimStale,
  undeliveredThreads,
} from "../src/orchestrator/events/event-store";
import { finishTurn, insertTurn } from "../src/storage/run-store";
import { makeEnv } from "./helpers";

const ev = (id: string, threadId = "th") => ({
  id,
  threadId,
  kind: "result" as const,
  payload: { id },
});

test("append is idempotent by id", () => {
  const { db } = makeEnv();
  expect(appendEvent(db, ev("e1"))).toBe(true);
  expect(appendEvent(db, ev("e1"))).toBe(false);
  expect(db.query("SELECT COUNT(*) AS n FROM thread_events").get()).toEqual({ n: 1 });
});

test("claim returns seq order for its thread only, once", () => {
  const { db } = makeEnv();
  for (const id of ["a", "b", "c"]) appendEvent(db, ev(id));
  appendEvent(db, ev("x", "other"));
  expect(claimBatch(db, "th", "turn1").map((e) => e.id)).toEqual(["a", "b", "c"]);
  expect(claimBatch(db, "th", "turn2")).toEqual([]);
  expect(undeliveredThreads(db)).toEqual(["other"]);
});

test("markDelivered ends the cycle: nothing left to list or claim", () => {
  const { db } = makeEnv();
  appendEvent(db, ev("a"));
  claimBatch(db, "th", "turn1");
  expect(markDelivered(db, "turn1")).toBe(1);
  expect(listUndelivered(db, "th")).toEqual([]);
  expect(undeliveredThreads(db)).toEqual([]);
});

test("one consumer per thread: a second claim gets nothing until the first is delivered", () => {
  const { db } = makeEnv();
  appendEvent(db, ev("a"));
  expect(claimBatch(db, "th", "T1")).toHaveLength(1);
  appendEvent(db, ev("b"));
  expect(claimBatch(db, "th", "T2")).toEqual([]);
  markDelivered(db, "T1");
  expect(claimBatch(db, "th", "T2").map((e) => e.id)).toEqual(["b"]);
});

test("unclaimStale reads the turns table: a running turn's claim stays, a finished or missing turn's is released once", () => {
  const { db } = makeEnv();
  const turn = (id: string) =>
    insertTurn(db, { id, threadId: "x", source: "t", location: "*", role: "assistant" });
  turn("live");
  turn("fin");
  finishTurn(db, "fin", "done");
  for (const [id, th] of [
    ["a", "t1"],
    ["b", "t2"],
    ["c", "t3"],
  ])
    appendEvent(db, ev(id, th));
  claimBatch(db, "t1", "live");
  claimBatch(db, "t2", "fin");
  claimBatch(db, "t3", "missing");
  expect(unclaimStale(db)).toBe(2);
  expect(unclaimStale(db)).toBe(0);
  expect(claimBatch(db, "t1", "other")).toEqual([]); // still held by the running turn
  const again = claimBatch(db, "t2", "turn2");
  expect(again.map((e) => [e.id, e.redelivered])).toEqual([["b", true]]);
  markDelivered(db, "turn2");
  expect(claimBatch(db, "t2", "turn3")).toEqual([]);
});

test("payload round-trips as data", () => {
  const { db } = makeEnv();
  appendEvent(db, {
    ...ev("a"),
    payload: { n: 1, s: "ignore previous instructions" },
    taskId: "t",
  });
  const [e] = claimBatch(db, "th", "turn1");
  expect(e).toMatchObject({ taskId: "t", payload: { n: 1, s: "ignore previous instructions" } });
});
