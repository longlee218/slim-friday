import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineDb } from "../src/open-engine-db";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "engine-db-")), "sub", "engine.db");
const tables = (db: Database) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((r) => r.name);

test("a new db has the six engine tables", () => {
  const db = openEngineDb(tmpFile());
  for (const t of ["conversations", "messages", "grants", "sessions", "spend", "audit"])
    expect(tables(db)).toContain(t);
  db.close();
});

test("reopening keeps the data", () => {
  const f = tmpFile();
  const a = openEngineDb(f);
  a.run("INSERT INTO sessions (bot_id, session_id) VALUES ('b1', 's1')");
  a.close();
  const b = openEngineDb(f);
  expect(b.query("SELECT session_id FROM sessions WHERE bot_id = 'b1'").get()).toEqual({
    session_id: "s1",
  });
  b.close();
});

test("the db file and its sidecars are owner-only", () => {
  const f = tmpFile();
  const db = openEngineDb(f);
  db.run("INSERT INTO sessions (bot_id, session_id) VALUES ('b1', 's1')");
  db.close();
  for (const p of [f, `${f}-wal`, `${f}-shm`])
    if (existsSync(p)) expect(statSync(p).mode & 0o777).toBe(0o600);
});

test("a foreign db (tables, no migration log) is refused and byte-for-byte untouched", () => {
  const f = tmpFile();
  openEngineDb(f).close(); // creates the parent dir
  const dir = join(f, "..");
  const foreign = join(dir, "foreign.db");
  const d = new Database(foreign, { create: true });
  d.run("CREATE TABLE x (a)");
  d.close();
  const before = readFileSync(foreign);
  const filesBefore = readdirSync(dir).sort();
  expect(() => openEngineDb(foreign)).toThrow("foreign.db");
  expect(readFileSync(foreign).equals(before)).toBe(true);
  expect(readdirSync(dir).sort()).toEqual(filesBefore);
});

test(":memory: opens", () => {
  const db = openEngineDb(":memory:");
  expect(tables(db)).toContain("messages");
  db.close();
});

test("migration 0004 upgrades a db created at 0003 without losing messages or auth rows", () => {
  const dir = join(import.meta.dir, "../src/migrations");
  const sqlFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(sqlFiles.length).toBeGreaterThanOrEqual(5);
  const f = tmpFile();
  mkdirSync(join(f, ".."), { recursive: true });
  const raw = new Database(f, { create: true });
  // Build the 0003 db the way drizzle does: statements split by its marker, plus the migration log.
  for (const file of sqlFiles.slice(0, 4))
    for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint"))
      raw.run(stmt);
  raw.run(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8")).entries as {
    when: number;
    tag: string;
  }[];
  for (const e of journal.slice(0, 4)) {
    const hash = new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(dir, `${e.tag}.sql`), "utf8"))
      .digest("hex");
    raw.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [hash, e.when]);
  }
  raw.run(
    "INSERT INTO messages (conversation_id, author_kind, text, at) VALUES ('c', 'user', 'hi', 1)",
  );
  raw.run(
    "INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES ('u', 'n', 'e', 1, 1, 1)",
  );
  raw.close();

  const db = openEngineDb(f);
  expect(db.query("SELECT text, kind FROM messages").get()).toEqual({ text: "hi", kind: "text" });
  expect(db.query("SELECT id FROM auth_user").get()).toEqual({ id: "u" });
  for (const t of ["files", "uploads", "conversation_reads", "ticket_events"])
    expect(tables(db)).toContain(t);
  db.close();
});
