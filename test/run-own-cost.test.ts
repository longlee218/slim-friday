import { expect, test } from "bun:test";
import { insertRun } from "../src/storage/run-metrics-store";
import { makeEnv } from "./helpers";

/* The SDK reports the total of the whole resumed session; a run stores its own share (the delta). */

const turn = (db: ReturnType<typeof makeEnv>["db"], id: string, session: string | null) =>
  db
    .query(
      "INSERT INTO turns (id, thread_id, source, location, status, started_at, session_id, role) VALUES (?, 't', 'test', '*', 'done', 1, ?, 'chief-of-staff')",
    )
    .run(id, session);

const run = (db: ReturnType<typeof makeEnv>["db"], turnId: string, costUsd: number) =>
  insertRun(db, {
    id: crypto.randomUUID(),
    turnId,
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    turns: 1,
    durationMs: 1,
    outcome: "success",
    compactions: 0,
  });

const costs = (db: ReturnType<typeof makeEnv>["db"]) =>
  db
    .query<{ c: number }, []>("SELECT cost_usd AS c FROM runs ORDER BY rowid")
    .all()
    .map((r) => Math.round(r.c * 1000) / 1000);

test("resumed runs of one session store the delta of the SDK total; the sum is the session cost", () => {
  const { db } = makeEnv();
  turn(db, "a", "s1");
  turn(db, "b", "s1");
  turn(db, "c", "s1");
  run(db, "a", 0.1);
  run(db, "b", 0.25);
  run(db, "c", 0.3);
  expect(costs(db)).toEqual([0.1, 0.15, 0.05]);
});

test("another session, or a turn with no session, keeps its total", () => {
  const { db } = makeEnv();
  turn(db, "a", "s1");
  turn(db, "b", "s2");
  turn(db, "c", null);
  run(db, "a", 0.4);
  run(db, "b", 0.2);
  run(db, "c", 0.3);
  expect(costs(db)).toEqual([0.4, 0.2, 0.3]);
});

test("a total below the earlier sum (a fresh session under the same id) is the run's own cost", () => {
  const { db } = makeEnv();
  turn(db, "a", "s1");
  turn(db, "b", "s1");
  run(db, "a", 0.5);
  run(db, "b", 0.1);
  expect(costs(db)).toEqual([0.5, 0.1]);
});
