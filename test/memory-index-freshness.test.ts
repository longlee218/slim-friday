import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DREAM_MIN_ITEMS } from "../src/config/memory-caps";
import { workspacePaths } from "../src/config/workspace-paths";
import { MEMORY_SEARCH_TOOL } from "../src/mcp/memory/tools/MemorySearchTool/constants";
import { searchIndex } from "../src/memory/index/memory-search";
import { dreamChannel } from "../src/memory/memory-dream";
import type { MemoryToolContext } from "../src/memory/memory-tool-context";
import { emptyUsage } from "../src/observability/run-usage";
import { openDb } from "../src/storage/db";
import { saveSummary } from "../src/storage/thread-summary-store";
import { memoryServer } from "./mcp-ctx-fixture";

/*
 * Index freshness: after every write path of channel memory, a search that does NOT sync first sees the change.
 * MemorySave and MemoryEdit are asserted in memory-edit-tool.test.ts, the compaction flush in compaction-flush.test.ts
 * ("file searchable"); here: the dream write and a writer that never re-indexes (a migration step).
 *
 * Known gap (documented, not fixed): the sync ledger compares file mtime (ms) and size, so two different contents of
 * the same size written within one millisecond would look unchanged to a SYNC. Every in-app writer re-indexes
 * directly (no ledger compare), so this only matters for an outside writer racing within a millisecond.
 */

const WS = "ws";
const CH = "ops";

test("dream: the consolidated MEMORY.md is searchable right after the dream, no sync in between", async () => {
  const home = mkdtempSync(join(tmpdir(), "fresh-"));
  const db = openDb(":memory:");
  const ch = workspacePaths(home).workspace(WS).channel(CH);
  mkdirSync(ch.root, { recursive: true });
  writeFileSync(ch.memory, "# ops\n\n## Decisions\n- use postgres (2026-10-01)\n");
  const now = new Date(2026, 9, 21, 12, 0).getTime();
  for (let i = 0; i < DREAM_MIN_ITEMS; i++)
    saveSummary(db, {
      threadId: `e${i}`,
      workspace: WS,
      channel: CH,
      summary: `Episode ${i}: the owner decided thing${i}.`,
      source: "idle",
      now: now - (DREAM_MIN_ITEMS - i) * 60_000,
    });
  const res = await dreamChannel(
    {
      db,
      home,
      state: { last: new Map(), running: new Set() },
      now: () => now,
      llm: async () => ({
        text: JSON.stringify({
          decisions: [{ text: "use postgres", date: "2026-10-01" }],
          facts: [{ text: "quokka cluster runs in frankfurt", date: "2026-10-20" }],
          preferences: [],
          lessons: [],
        }),
        usage: emptyUsage(),
      }),
    },
    WS,
    CH,
  );
  expect(res).toBe("dreamed");
  const hits = searchIndex(db, WS, { query: "quokka", limit: 5, channel: CH }).hits;
  expect(hits).toHaveLength(1);
});

test("a writer that does not re-index (a migration step) is caught by the next MemorySearch sync", async () => {
  const home = mkdtempSync(join(tmpdir(), "fresh-"));
  const db = openDb(":memory:");
  const ctx: MemoryToolContext = {
    db,
    home,
    workspace: WS,
    channel: CH,
    threadLabel: "t",
    now: () => new Date(2026, 9, 21),
  };
  const file = workspacePaths(home).workspace(WS).channel(CH).memory;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "# ops\n\n## Facts\n- migrated wombat fact (2026-10-01)\n");
  expect(searchIndex(db, WS, { query: "wombat", limit: 5, channel: CH }).hits).toEqual([]); // not indexed yet
  const server = memoryServer(ctx) as unknown as {
    instance: {
      _registeredTools: Record<
        string,
        { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }
      >;
    };
  };
  const r = await server.instance._registeredTools[MEMORY_SEARCH_TOOL]?.handler(
    { query: "wombat" },
    {},
  );
  expect(r?.content[0]?.text).toContain("wombat");
});
