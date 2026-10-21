import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFLECT_WINDOW_MS } from "../src/config/memory-caps";
import { journalFile } from "../src/memory/daily-journal";
import { reflectClosedGoals } from "../src/memory/goal-reflection";
import type { CompactLlm } from "../src/memory/memory-compaction-llm";
import { emptyUsage } from "../src/observability/run-usage";
import { REFLECT_SYSTEM } from "../src/roles/prompts/memory-prompts";
import { openDb } from "../src/storage/db";

/* Reflection on goals that closed with a failure signal: selection, one lesson to the journal, NO_ENTRY, bad reply,
   marking (no second call), unmapped channel. Real db rows, fake model. */

const NOW = new Date(2026, 9, 21, 22, 30).getTime();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One task row (a goal when `parent` is absent). */
function task(
  db: Database,
  id: string,
  status: string,
  over: { parent?: string; key?: string; at?: number; excerpt?: string } = {},
) {
  db.query(
    `INSERT INTO owned_tasks (id, thread_id, owner_role, status, scope, correlation_id, created_at, last_progress_at, parent_id, item_key, result_excerpt)
     VALUES (?, 'th1', 'developer', ?, 'add login', 'c', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    status,
    NOW - 1000,
    over.at ?? NOW - 1000,
    over.parent ?? null,
    over.key ?? null,
    over.excerpt ?? null,
  );
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "goal-reflection-"));
  dirs.push(home);
  const db = openDb(":memory:");
  db.query(
    "INSERT INTO threads (thread_id, channel_id, origin, created_at, updated_at) VALUES ('th1', 'ch1', 'bot', 1, 1)",
  ).run();
  const journal = () => journalFile(home, "w", "dev", "2026-10-21");
  return { home, db, journal };
}

function fakeLlm(reply: string | Error) {
  const calls: { system: string; prompt: string }[] = [];
  const llm: CompactLlm = async (system, prompt) => {
    calls.push({ system, prompt });
    if (reply instanceof Error) throw reply;
    return { text: reply, usage: emptyUsage() };
  };
  return { llm, calls };
}

const resolve = (id: string) => (id === "ch1" ? { workspace: "w", channel: "dev" } : null);
const LESSON = JSON.stringify({
  cue: "a verify fails on a missing table",
  lesson: "the developer runs migrations before the tests",
  evidence: "verify-1 failed, fix-1 ran migrations",
});

test("a goal with a fix loop gets one lesson in the journal, then is marked (no second call)", async () => {
  const s = setup();
  task(s.db, "goal0001xx", "completed");
  task(s.db, "i1", "cancelled", {
    parent: "goal0001xx",
    key: "verify-1",
    excerpt: "FAILED: table users missing",
  });
  task(s.db, "i2", "completed", { parent: "goal0001xx", key: "fix-1", excerpt: "ran migrations" });
  const f = fakeLlm(LESSON);
  const deps = { db: s.db, home: s.home, llm: f.llm, resolve, now: () => NOW };
  expect(await reflectClosedGoals(deps)).toBe(1);
  expect(f.calls[0]?.system).toBe(REFLECT_SYSTEM);
  expect(f.calls[0]?.prompt).toContain(
    "verify-1 (developer) [cancelled]: FAILED: table users missing",
  );
  const text = readFileSync(s.journal(), "utf8");
  expect(text).toContain("Reflection - goal goal0001");
  expect(text).toContain(
    "- When a verify fails on a missing table: the developer runs migrations before the tests — evidence: goal goal0001: verify-1 failed, fix-1 ran migrations",
  );
  expect(await reflectClosedGoals(deps)).toBe(0);
  expect(f.calls).toHaveLength(1);
});

test("no failure signal, still open, or closed before the window: no call", async () => {
  const s = setup();
  task(s.db, "clean", "completed");
  task(s.db, "c1", "completed", { parent: "clean", key: "a" });
  task(s.db, "open", "running");
  task(s.db, "o1", "failed", { parent: "open", key: "a" });
  task(s.db, "old", "failed", { at: NOW - REFLECT_WINDOW_MS - 1 });
  task(s.db, "x1", "failed", { parent: "old", key: "a" });
  const f = fakeLlm(LESSON);
  expect(
    await reflectClosedGoals({ db: s.db, home: s.home, llm: f.llm, resolve, now: () => NOW }),
  ).toBe(0);
  expect(f.calls).toHaveLength(0);
});

test("NO_ENTRY, a bad reply and a model error write nothing but mark the goal", async () => {
  for (const reply of [
    '{"entry":"NO_ENTRY"}',
    "no idea",
    '{"cue":"x","lesson":"y"}',
    new Error("overloaded"),
  ]) {
    const s = setup();
    task(s.db, "g", "failed");
    task(s.db, "g1", "failed", { parent: "g", key: "a" });
    const f = fakeLlm(reply);
    const deps = { db: s.db, home: s.home, llm: f.llm, resolve, now: () => NOW };
    expect(await reflectClosedGoals(deps)).toBe(0);
    expect(existsSync(s.journal())).toBe(false);
    await reflectClosedGoals(deps);
    expect(f.calls).toHaveLength(1);
  }
});

test("an unmapped channel: no call, the goal is marked", async () => {
  const s = setup();
  task(s.db, "g", "failed");
  task(s.db, "g1", "failed", { parent: "g", key: "a" });
  const f = fakeLlm(LESSON);
  const deps = { db: s.db, home: s.home, llm: f.llm, resolve: () => null, now: () => NOW };
  expect(await reflectClosedGoals(deps)).toBe(0);
  await reflectClosedGoals({ ...deps, resolve });
  expect(f.calls).toHaveLength(0);
});
