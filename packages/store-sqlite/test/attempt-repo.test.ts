import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineStore } from "../src/engine-store";

const rows = (file: string) => {
  const db = new Database(file, { readonly: true });
  const r = db.query("SELECT * FROM run_attempts").all();
  db.close();
  return r;
};

test("start records a running attempt and finish closes it", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "attempt-")), "engine.db");
  const s = openEngineStore(file);
  await s.attempts.start({ id: "a1", wakeId: "w1", fence: 1, owner: "boot:w1", startedAt: 5 });
  expect(rows(file)).toMatchObject([
    { id: "a1", status: "running", ended_at: null, started_at: 5 },
  ]);
  await s.attempts.finish("a1", "failed", 9, "boom");
  expect(rows(file)).toMatchObject([
    { id: "a1", status: "failed", ended_at: 9, error: "boom", wake_id: "w1", fence: 1 },
  ]);
  s.close();
});

test("finish closes only a running attempt: the first status wins", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "attempt-")), "engine.db");
  const s = openEngineStore(file);
  await s.attempts.start({ id: "a1", wakeId: "w1", fence: 1, owner: "boot:w1", startedAt: 5 });
  await s.attempts.finish("a1", "interrupted", 7);
  await s.attempts.finish("a1", "done", 9);
  expect(rows(file)).toMatchObject([{ id: "a1", status: "interrupted", ended_at: 7 }]);
  s.close();
});
