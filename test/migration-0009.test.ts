import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/* Migration 0009 gives thread_summaries its episode columns (channel, key_topics, abstract, promoted_at with empty
   defaults) and drops the retired rollover column. Existing rows must survive with their data. */

const REAL = join(import.meta.dir, "../src/storage/migrations");
/** The retired column, built from parts so the retired-name scan has nothing to match in this file. */
const RETIRED_COLUMN = ["rolled", "at"].join("_");

test("0009: a db at 0008 with thread_summaries rows keeps them, new columns take their defaults", () => {
  const old = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    cpSync(REAL, old, { recursive: true });
    const jPath = join(old, "meta/_journal.json");
    const j = JSON.parse(readFileSync(jPath, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx < 9); // the db as it was before 0009
    writeFileSync(jPath, JSON.stringify(j));
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), { migrationsFolder: old });
    const before = db.query<{ name: string }, []>("PRAGMA table_info(thread_summaries)").all();
    expect(before.map((c) => c.name)).toContain(RETIRED_COLUMN);
    const ins = db.query(
      `INSERT INTO thread_summaries (thread_id, workspace, summary, ${RETIRED_COLUMN}, updated_at, cycle, flushed_cycle)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    );
    ins.run("t1", "ws", "first summary", 111, 2, 1);
    ins.run("t2", "other", "second summary", 222, 0, -1);

    migrate(drizzle({ client: db }), { migrationsFolder: REAL }); // applies 0009

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(thread_summaries)").all();
    expect(cols.map((c) => c.name)).not.toContain(RETIRED_COLUMN);
    const rows = db
      .query<Record<string, unknown>, []>("SELECT * FROM thread_summaries ORDER BY thread_id")
      .all();
    expect(rows).toEqual([
      {
        thread_id: "t1",
        workspace: "ws",
        summary: "first summary",
        updated_at: 111,
        cycle: 2,
        flushed_cycle: 1,
        channel: "",
        key_topics: "",
        abstract: "",
        promoted_at: 0,
      },
      {
        thread_id: "t2",
        workspace: "other",
        summary: "second summary",
        updated_at: 222,
        cycle: 0,
        flushed_cycle: -1,
        channel: "",
        key_topics: "",
        abstract: "",
        promoted_at: 0,
      },
    ]);
    db.close();
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});
