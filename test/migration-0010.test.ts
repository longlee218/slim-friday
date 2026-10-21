import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/* Migration 0010 adds the `memory_promotions` ledger and touches nothing else: data of a db at 0009 survives. */

const REAL = join(import.meta.dir, "../src/storage/migrations");

test("0010: a db at 0009 keeps its rows and gets an empty ledger with the composite key", () => {
  const old = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    cpSync(REAL, old, { recursive: true });
    const jPath = join(old, "meta/_journal.json");
    const j = JSON.parse(readFileSync(jPath, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx < 10); // the db as it was before 0010
    writeFileSync(jPath, JSON.stringify(j));
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), { migrationsFolder: old });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name = 'memory_promotions'").all(),
    ).toEqual([]);
    db.run(
      "INSERT INTO thread_summaries (thread_id, workspace, channel, summary, promoted_at, updated_at) VALUES ('t1', 'ws', 'ops', 'kept text', 5, 9)",
    );
    db.run("INSERT INTO memory_files (path, workspace, mtime_ms, size) VALUES ('/p', 'ws', 1, 2)");

    migrate(drizzle({ client: db }), { migrationsFolder: REAL }); // applies 0010

    expect(
      db.query("SELECT thread_id, summary, promoted_at, updated_at FROM thread_summaries").all(),
    ).toEqual([{ thread_id: "t1", summary: "kept text", promoted_at: 5, updated_at: 9 }]);
    expect(db.query("SELECT path FROM memory_files").all()).toEqual([{ path: "/p" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM memory_promotions").get()).toEqual({ n: 0 });
    db.run("INSERT INTO memory_promotions VALUES ('ws', 'ops', 'h1', 1)");
    expect(() => db.run("INSERT INTO memory_promotions VALUES ('ws', 'ops', 'h1', 2)")).toThrow();
    db.run("INSERT INTO memory_promotions VALUES ('ws', 'other', 'h1', 2)");
    db.close();
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});
