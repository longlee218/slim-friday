import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMemoryMetrics, memoryMetrics } from "../src/observability/memory-metrics";
import { openDb } from "../src/storage/db";
import { recordMemoryAudit } from "../src/storage/memory-audit-store";
import { missingMemoryTables } from "../src/storage/memory-metrics-store";
import { markPromoted } from "../src/storage/memory-promotion-store";
import { saveSummary } from "../src/storage/thread-summary-store";

// Noon local time of a fixed day: the local-day grouping is the same in SQL and in JS whatever the TZ.
const NOON = new Date(2026, 9, 20, 12, 0, 0).getTime();
const DAY = "2026-10-20";
const NOW = NOON + 3_600_000;

const log = (time: number, event: string, f: Record<string, unknown> = {}) =>
  JSON.stringify({ level: 30, time, event, ...f });

test("counts per channel and day from a temp db and log lines; no text in the output", () => {
  const db = openDb(":memory:");
  const audit = (action: "save" | "edit_delete" | "edit_replace", ts = NOON) =>
    recordMemoryAudit(db, {
      ts,
      threadId: "t1",
      channel: "dev",
      role: "chief-of-staff",
      action,
      scope: "channel",
      hash: "abc",
    });
  audit("save");
  audit("save");
  audit("edit_delete");
  audit("edit_replace");
  audit("save", NOON - 30 * 86_400_000); // outside the window
  saveSummary(db, {
    threadId: "t1",
    workspace: "ws",
    channel: "dev",
    summary: "SECRET-SUMMARY-TEXT about deploys",
    source: "idle",
    now: NOON,
  });
  db.query("UPDATE thread_summaries SET promoted_at = ? WHERE thread_id = 't1'").run(NOON);
  markPromoted(db, "ws", "dev", ["h1", "h2"], NOON);

  const lines = [
    log(NOON, "memory.flush", { channel: "dev", mode: "llm" }),
    log(NOON, "memory.flush", { channel: "dev", mode: "fallback" }),
    log(NOON, "memory.flush", { channel: "dev", mode: "llm" }),
    log(NOON, "memory.dream", { channel: "dev", episodes: 1 }),
    log(NOON, "memory.dream_skipped", { channel: "dev", reason: "debounce" }),
    log(NOON, "memory.dream_failed", { channel: "dev", reason: "io_failed" }),
    log(NOON, "memory.prune", { episodes: 2, journals: 1, promotions: 3 }),
    log(NOON - 30 * 86_400_000, "memory.flush", { channel: "dev", mode: "llm" }), // outside
    log(NOON, "run.finished"), // other event
    "not json {",
  ];
  const m = memoryMetrics(db, lines, 7, NOW);
  expect(m.rows).toEqual([
    {
      channel: "dev",
      day: DAY,
      saves: 2,
      editDeletes: 1,
      editReplaces: 1,
      flushes: { llm: 2, fallback: 1 },
      episodes: 1,
      dreams: 1,
      dreamSkips: { debounce: 1, io_failed: 1 },
      promotedEpisodes: 1,
      promotedJournal: 2,
    },
  ]);
  expect(m.prune).toEqual({ runs: 1, episodes: 2, journals: 1, promotions: 3 });

  const text = formatMemoryMetrics(m, 7);
  expect(text).toContain("dev 2026-10-20: saves 2, edits 2 (delete 1, replace 1)");
  expect(text).toContain("flushes fallback:1,llm:2");
  expect(text).not.toContain("SECRET");
  db.close();
});

test("empty db and no log: a readable empty report", () => {
  const db = openDb(":memory:");
  const text = formatMemoryMetrics(memoryMetrics(db, [], 1, NOW), 1);
  expect(text).toContain("(no memory activity)");
  expect(text).toContain("prune (all channels): 0 run(s)");
  db.close();
});

test("db without the memory tables: missing list, and the CLI exits 1 with one line", () => {
  const home = mkdtempSync(join(tmpdir(), "mm-"));
  mkdirSync(join(home, "data"));
  const old = new Database(join(home, "data", "agent.db"));
  old.run("CREATE TABLE memory_audit (id INTEGER)");
  expect(missingMemoryTables(old)).toEqual(["thread_summaries", "memory_promotions"]);
  old.close();

  const r = Bun.spawnSync(["bun", "scripts/metrics-memory.ts"], {
    env: { ...process.env, AGENT_HOME: home },
  });
  expect(r.exitCode).toBe(1);
  const err = r.stderr.toString().trim();
  expect(err).toBe(
    "metrics:memory: db has no thread_summaries, memory_promotions: start the bot once to apply migrations",
  );
});
