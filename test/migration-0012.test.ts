import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/* Migration 0012 adds the nullable `memory_audit.old_hash`: rows of a db at 0011 survive with a null old hash. */

const REAL = join(import.meta.dir, "../src/storage/migrations");

test("0012: audit rows of a db at 0011 are kept, old_hash is null", () => {
  const old = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    cpSync(REAL, old, { recursive: true });
    const jPath = join(old, "meta/_journal.json");
    const j = JSON.parse(readFileSync(jPath, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx < 12); // the db as it was before 0012
    writeFileSync(jPath, JSON.stringify(j));
    const db = new Database(":memory:");
    migrate(drizzle({ client: db }), { migrationsFolder: old });
    db.run(
      "INSERT INTO memory_audit (ts, thread_id, channel, role, action, scope, hash) VALUES (1, 't', 'c', 'lead', 'edit_replace', 'channel', 'abc')",
    );

    migrate(drizzle({ client: db }), { migrationsFolder: REAL }); // applies 0012

    expect(db.query("SELECT hash, old_hash FROM memory_audit").all()).toEqual([
      { hash: "abc", old_hash: null },
    ]);
    db.close();
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});
