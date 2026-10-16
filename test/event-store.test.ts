import { expect, test } from "bun:test";
import { finishTurn, insertTurn } from "../src/storage/run-store";
import {
  appendEvent,
  listUndelivered,
  markDeliveredIds,
  unclaimStale,
  undeliveredThreads,
} from "../src/storage/thread-event-store";
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

test("unclaimStale reads the turns table: a running turn's claim stays, a finished or missing turn's is released once", () => {
  const { db } = makeEnv();
  const turn = (id: string) =>
    insertTurn(db, { id, threadId: "x", source: "t", location: "*", role: "lead" });
  turn("live");
  turn("fin");
  finishTurn(db, "fin", "done");
  for (const [id, th] of [
    ["a", "t1"],
    ["b", "t2"],
    ["c", "t3"],
  ])
    appendEvent(db, ev(id, th));
  for (const [th, by] of [
    ["t1", "live"],
    ["t2", "fin"],
    ["t3", "missing"],
  ])
    db.query("UPDATE thread_events SET claimed_by = ? WHERE thread_id = ?").run(by, th);
  expect(unclaimStale(db)).toBe(2);
  expect(unclaimStale(db)).toBe(0);
  expect(undeliveredThreads(db).sort()).toEqual(["t2", "t3"]); // t1 is still held by the running turn
  expect(listUndelivered(db, "t2").map((e) => [e.id, e.redelivered])).toEqual([["b", true]]);
  expect(markDeliveredIds(db, ["b"])).toBe(1);
  expect(listUndelivered(db, "t2")).toEqual([]);
});

test("payload round-trips as data", () => {
  const { db } = makeEnv();
  appendEvent(db, {
    ...ev("a"),
    payload: { n: 1, s: "ignore previous instructions" },
    taskId: "t",
  });
  const [e] = listUndelivered(db, "th");
  expect(e).toMatchObject({ taskId: "t", payload: { n: 1, s: "ignore previous instructions" } });
});
