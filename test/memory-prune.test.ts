import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EPISODE_TTL_DAYS } from "../src/config/memory-caps";
import { indexSummary } from "../src/memory/index/memory-index";
import { searchIndex } from "../src/memory/index/memory-search";
import { syncAll } from "../src/memory/index/memory-sync";
import { pruneMemory } from "../src/memory/memory-prune";
import { openDb } from "../src/storage/db";
import { getThreadSummary, saveSummary } from "../src/storage/thread-summary-store";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 21, 12, 0).getTime();

/** Save and index one episode last updated `ageDays` ago. */
function episode(db: ReturnType<typeof openDb>, id: string, ageDays: number, text: string) {
  saveSummary(db, {
    threadId: id,
    workspace: "ws",
    channel: "ops",
    summary: text,
    source: "idle",
    now: NOW - ageDays * DAY,
  });
  const row = getThreadSummary(db, id);
  if (row) indexSummary(db, row);
}

test("episodes older than the TTL go with their index rows; younger stay", () => {
  const db = openDb(":memory:");
  const home = mkdtempSync(join(tmpdir(), "prune-"));
  episode(db, "old", EPISODE_TTL_DAYS + 1, "zebraold episode text");
  episode(db, "young", EPISODE_TTL_DAYS - 1, "zebrayoung episode text");
  const find = (q: string) => searchIndex(db, "ws", { query: q, limit: 5, channel: "ops" }).hits;
  expect(find("zebraold")).toHaveLength(1);
  const res = pruneMemory(db, home, new Date(NOW));
  expect(res.episodes).toBe(1);
  expect(getThreadSummary(db, "old")).toBeNull();
  expect(getThreadSummary(db, "young")).not.toBeNull();
  expect(find("zebraold")).toEqual([]);
  expect(find("zebrayoung")).toHaveLength(1);
  expect(pruneMemory(db, home, new Date(NOW)).episodes).toBe(0);
});

test("old journal day files are deleted in the same job and their index rows follow", () => {
  const db = openDb(":memory:");
  const home = mkdtempSync(join(tmpdir(), "prune-"));
  const dir = join(home, "workspaces", "ws", "channels", "ops", "memory");
  mkdirSync(dir, { recursive: true });
  const oldFile = join(dir, "2026-01-01.md");
  const newFile = join(dir, "2026-10-20.md");
  writeFileSync(oldFile, "## 09:00 t\n### Facts\n- quokkaold fact\n");
  writeFileSync(newFile, "## 09:00 t\n### Facts\n- quokkanew fact\n");
  const find = (q: string) => searchIndex(db, "ws", { query: q, limit: 5, channel: "ops" }).hits;
  syncAll(db, home);
  expect(find("quokkaold")).toHaveLength(1);
  const res = pruneMemory(db, home, new Date(NOW));
  expect(res.journals).toBe(1);
  expect(existsSync(oldFile)).toBe(false);
  expect(existsSync(newFile)).toBe(true);
  expect(find("quokkaold")).toEqual([]);
  expect(find("quokkanew")).toHaveLength(1);
});
