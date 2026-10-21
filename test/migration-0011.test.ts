import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/* Migration 0011 adds the `memory_audit` table and touches nothing else: data of a db at 0010 survives. */

const REAL = join(import.meta.dir, "../src/storage/migrations");

test("0011: a db at 0010 keeps its rows and gets an empty audit table", () => {
  const old = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    cpSync(REAL, old, { recursive: true });
    const jPath = join(old, "meta/_journal.json");
    const j = JSON.parse(readFileSync(jPath, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx < 11); // the db as it was before 0011
    writeFileSync(jPath, JSON.stringify(j));
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), { migrationsFolder: old });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'memory_audit'").all()).toEqual(
      [],
    );
    db.run("INSERT INTO memory_promotions VALUES ('ws', 'ops', 'h1', 1)");

    migrate(drizzle({ client: db }), { migrationsFolder: REAL }); // applies 0011

    expect(db.query("SELECT hash FROM memory_promotions").all()).toEqual([{ hash: "h1" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM memory_audit").get()).toEqual({ n: 0 });
    db.run(
      "INSERT INTO memory_audit (ts, thread_id, channel, role, action, scope, hash) VALUES (1, 't', 'c', 'lead', 'save', 'channel', 'abc')",
    );
    expect(db.query("SELECT id, action FROM memory_audit").all()).toEqual([
      { id: 1, action: "save" },
    ]);
    db.close();
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});
