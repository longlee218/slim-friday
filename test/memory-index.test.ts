import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMatch, foldText, queryTerms } from "../src/memory/index/fold-text";
import { chunkJournal, chunkMemory } from "../src/memory/index/memory-chunker";
import { classifyFile } from "../src/memory/index/memory-files";
import { hash6, makeId, parseId } from "../src/memory/index/memory-ids";
import {
  CHUNK_MAX_CHARS,
  INDEX_MAX_CHUNKS_PER_FILE,
  INDEX_MAX_FILE_BYTES,
  reindexFile,
} from "../src/memory/index/memory-index";
import { searchIndex } from "../src/memory/index/memory-search";
import { syncAll, syncIndex } from "../src/memory/index/memory-sync";
import { openDb } from "../src/storage/db";
import { saveSummary } from "../src/storage/thread-summary-store";
import { STRAY_QUEUE_FILE } from "./memory-fixture";

/** Temp home + db with helpers to write files under it. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "memidx-"));
  const db = openDb(":memory:");
  const put = (rel: string, text: string) => {
    const f = join(home, rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, text);
    return f;
  };
  const find = (ws: string, query: string, extra: Record<string, unknown> = {}) =>
    searchIndex(db, ws, { query, limit: 20, channel: "c1", ...extra } as never).hits;
  return { home, db, put, find };
}
const MEM = (s: string) => `# M\n\n## Decisions\n${s}\n`;

test("fold: đ -> d, NFD -> NFC, accents stripped by the tokenizer", () => {
  expect(foldText("Đường dẫn")).toBe("Dường dẫn");
  expect(foldText("ệ")).toBe("ệ");
  expect(queryTerms('foo" OR workspace:b* NEAR(', 200, 12)).toEqual([
    "foo",
    "or",
    "workspace",
    "b",
    "near",
  ]);
  expect(queryTerms("a b c d e f g h i j k l m n", 200, 12)).toHaveLength(12);
  expect(queryTerms("!!! ... ́", 200, 12)).toEqual([]);
  expect(buildMatch(["a", "b"])).toBe('"a" OR "b"');
});

test("ids: round trip and hostile input", () => {
  const id = makeId("channel/finance", "Decisions", 2, hash6("Use Bun."));
  expect(parseId(id)).toMatchObject({
    type: "file",
    source: "channel",
    channel: "finance",
    token: "Decisions",
    n: 2,
  });
  expect(hash6("Use  bun")).toBe(hash6("use bun."));
  expect(parseId("journal/finance/2026-10-13#09:05:1~abcdef")).toMatchObject({
    type: "journal",
    channel: "finance",
    date: "2026-10-13",
  });
  expect(parseId("summary/123@4")).toEqual({ type: "summary", threadId: "123", cycle: 4 });
  for (const bad of [
    "../x",
    "root#Evil:1~abcdef",
    "location/../x#Facts:1~abcdef",
    "location/api#Facts:1~abcdef", // retired layers
    "workspace#Facts:1~abcdef",
    "channel/../x#Facts:1~abcdef",
    "root#Facts:1~ZZZZZZ",
    "x".repeat(500),
    "summary/a/b@1",
    "root#Facts:1~abcdef\n",
    "%",
    "' OR 1=1 --",
    "journal/2026-10-13#09:05:1~abcdef", // old id format (no channel)
    "journal/finance/2026-1-1#09:05:1~abcdef",
    "journal/../2026-10-13#09:05:1~abcdef",
    "",
    5,
  ])
    expect(parseId(bad)).toBeNull();
});

test("chunker: bullets by section, legacy Other/Text, journal blocks, CRLF", () => {
  const t =
    "# T\n\n## Decisions\n- use bun (2026-10-01)\n- no mocks\n\n## 2026-01 old\n- legacy one\nprose line\nmore\n";
  const c = chunkMemory(t.replace(/\n/g, "\r\n"), "2026-02-02");
  expect(c.map((x) => [x.token, x.n, x.text, x.date])).toEqual([
    ["Decisions", 1, "use bun", "2026-10-01"],
    ["Decisions", 2, "no mocks", "2026-02-02"],
    ["Other", 1, "legacy one", "2026-02-02"],
    ["Text", 1, "prose line more", "2026-02-02"],
  ]);
  expect(c[0]?.context).toContain("- no mocks");
  expect(c[0]?.context).not.toContain("legacy");
  const j = chunkJournal(
    "# J\n## 09:05 thread a\n### Facts\n- x\n## 09:05 thread b\n### Open\n- y\n",
    "2026-10-13",
  );
  expect(j.map((x) => [x.token, x.n, x.section])).toEqual([
    ["09:05", 1, "thread a"],
    ["09:05", 2, "thread b"],
  ]);
  expect(j[0]?.text).toContain("### Facts");
  expect(j[0]?.text).not.toContain("thread b");
});

test("classify: only the three shapes; retired workspace and location files, pending, AGENTS, odd paths refused", () => {
  const { home } = setup();
  const c = (rel: string) => classifyFile(home, join(home, rel));
  expect(c("MEMORY.md")).toMatchObject({ source: "root", workspace: "" });
  expect(c("workspaces/a/channels/c1/MEMORY.md")).toMatchObject({
    source: "channel",
    channel: "c1",
  });
  expect(c("workspaces/a/channels/c1/memory/2026-10-13.md")).toMatchObject({
    source: "journal",
    channel: "c1",
    date: "2026-10-13",
  });
  for (const bad of [
    STRAY_QUEUE_FILE,
    "workspaces/a/MEMORY.md",
    "workspaces/a/locations/api/MEMORY.md",
    "AGENTS.md",
    "workspaces/a/AGENTS.md",
    "workspaces/a/memory/notes.md",
    "workspaces/a/memory/2026-10-13.md", // old per-space journal: unread
    "workspaces/a/channels/c1/memory/notes.md",
    "workspaces/a/channels/C_1/memory/2026-10-13.md",
    "workspaces/a/channels/c1/memory/x/2026-10-13.md",
    "workspaces/A_/MEMORY.md",
    "../x/MEMORY.md",
    "workspaces/a/locations/api/location/MEMORY.md",
  ])
    expect(c(bad)).toBeNull();
  expect(classifyFile(home, "/etc/passwd")).toBeNull();
});

test("ranking: more terms and rarer terms win; limit and filters", () => {
  const s = setup();
  s.put(
    "workspaces/a/channels/c1/MEMORY.md",
    `${MEM("- alpha beta gamma\n- alpha only\n- gamma gamma gamma plus alpha")}\n## Lessons\n- alpha lesson\n`,
  );
  syncIndex(s.db, s.home, "a");
  const hits = s.find("a", "alpha beta");
  expect(hits[0]?.snippet).toContain("alpha beta gamma");
  expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  expect(s.find("a", "alpha", { limit: 2 })).toHaveLength(2);
  expect(s.find("a", "alpha", { kind: "lesson" }).map((h) => h.snippet)).toEqual(["alpha lesson"]);
  expect(s.find("a", "alpha", { scope: "journal" })).toEqual([]);
  expect(s.find("a", "alpha", { scope: "channel" }).length).toBeGreaterThan(0);
});

test("since filter uses the entry date (undated: file mtime day)", () => {
  const s = setup();
  const f = s.put(
    "workspaces/a/channels/c1/MEMORY.md",
    "## Facts\n- old fact (2026-01-01)\n- new fact (2026-10-10)\n- undated fact\n",
  );
  utimesSync(f, new Date(2026, 5, 1), new Date(2026, 5, 1));
  syncIndex(s.db, s.home, "a");
  expect(s.find("a", "fact", { since: "2026-10-01" }).map((h) => h.snippet)).toEqual(["new fact"]);
  expect(s.find("a", "fact", { since: "2026-05-01" })).toHaveLength(2);
});

test("accent-insensitive Vietnamese including đ", () => {
  const s = setup();
  s.put(
    "workspaces/a/channels/c1/MEMORY.md",
    MEM("- quyết định dùng pnpm (2026-10-01)\n- đường dẫn gốc là /srv (2026-10-02)"),
  );
  syncIndex(s.db, s.home, "a");
  // Snippets show the folded text (đ -> d): the index stores the folded form; MemoryGet returns the original.
  for (const q of ["quyet dinh", "QUYẾT ĐỊNH", "dinh", "quyết dịnh"])
    expect(s.find("a", q).map((h) => h.snippet)).toContain("quyết định dùng pnpm");
  expect(s.find("a", "duong dan")).toHaveLength(1);
  expect(s.find("a", "đường dẫn")).toHaveLength(1);
  expect(s.find("a", "ĐƯỜNG")).toHaveLength(1);
});

test("workspace isolation (memory, journal, summary); root visible to both; pending never indexed", () => {
  const s = setup();
  s.put("MEMORY.md", MEM("- rootword shared"));
  s.put(STRAY_QUEUE_FILE, MEM("- pendingword secret"));
  s.put("AGENTS.md", "agentsword\n");
  for (const ws of ["a", "b"]) {
    s.put(`workspaces/${ws}/channels/c1/MEMORY.md`, MEM(`- zebra ${ws}`));
    s.put(
      `workspaces/${ws}/channels/c1/memory/2026-10-13.md`,
      `## 09:00 t\n### Facts\n- zebra journal ${ws}\n`,
    );
    saveSummary(s.db, `th${ws}`, ws, `zebra summary ${ws}`);
  }
  syncAll(s.db, s.home);
  expect(
    s
      .find("a", "zebra")
      .map((h) => h.snippet)
      .sort(),
  ).toEqual(["zebra a", "zebra summary a", expect.stringContaining("zebra journal a")].sort());
  expect(s.find("b", "zebra").every((h) => !h.snippet.includes(" a"))).toBe(true);
  expect(s.find("a", "rootword")).toHaveLength(1);
  expect(s.find("b", "rootword")).toHaveLength(1);
  for (const w of ["pendingword", "agentsword"]) expect(s.find("a", w)).toEqual([]);
  expect(reindexFile(s.db, s.home, join(s.home, STRAY_QUEUE_FILE))).toBe("skipped");
  expect(s.find("a", "pendingword")).toEqual([]);
  // same-workspace summaries from several threads
  saveSummary(s.db, "th2", "a", "zebra second thread");
  syncIndex(s.db, s.home, "a");
  expect(s.find("a", "zebra", { scope: "summary" })).toHaveLength(2);
  expect(s.find("b", "zebra", { scope: "summary" })).toHaveLength(1);
});

test("FTS syntax in the query is inert", () => {
  const s = setup();
  s.put("workspaces/a/channels/c1/MEMORY.md", MEM("- foo bar"));
  s.put("workspaces/b/channels/c1/MEMORY.md", MEM("- foo secretb"));
  syncAll(s.db, s.home);
  const r = searchIndex(s.db, "a", {
    query: 'foo" OR workspace:b* NEAR(',
    limit: 20,
    channel: "c1",
  });
  expect(r.hits.map((h) => h.snippet)).toEqual(["foo bar"]);
  expect(searchIndex(s.db, "a", { query: '"*^(', limit: 5, channel: "c1" })).toEqual({
    hits: [],
    terms: 0,
  });
});

test("freshness: unchanged file is not re-read; changed file replaced; deleted purged; symlink refused", () => {
  const s = setup();
  const f = s.put("workspaces/a/channels/c1/MEMORY.md", MEM("- first note"));
  syncIndex(s.db, s.home, "a");
  s.db.query("UPDATE memory_fts SET text = 'sentinel words'").run(); // tamper: a re-read would restore 'first note'
  expect(syncIndex(s.db, s.home, "a").reindexed).toBe(0);
  expect(s.find("a", "sentinel")).toHaveLength(1);
  writeFileSync(f, MEM("- second note, longer"));
  expect(syncIndex(s.db, s.home, "a").reindexed).toBe(1);
  expect(s.find("a", "sentinel")).toEqual([]);
  expect(s.find("a", "second")).toHaveLength(1);
  expect(s.find("a", "first")).toEqual([]);
  const out = join(s.home, "outside.md");
  writeFileSync(out, MEM("- linked secret"));
  const link = join(s.home, "workspaces/a/channels/c2/MEMORY.md");
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(out, link);
  syncIndex(s.db, s.home, "a");
  expect(s.find("a", "linked")).toEqual([]);
  require("node:fs").rmSync(f);
  expect(syncIndex(s.db, s.home, "a").purged).toBe(1);
  expect(s.find("a", "second")).toEqual([]);
});

test("caps: big file skipped, chunks per file, chunk text clipped, summaries of a deleted thread purged", () => {
  const s = setup();
  s.put(
    "workspaces/a/channels/c1/MEMORY.md",
    `## Facts\n${"- bigword filler\n".repeat(INDEX_MAX_FILE_BYTES / 10)}`,
  );
  s.put(
    "workspaces/a/channels/c2/MEMORY.md",
    `## Facts\n${Array.from({ length: INDEX_MAX_CHUNKS_PER_FILE + 5 }, (_, i) => `- item${i} x`).join("\n")}\n`,
  );
  s.put("workspaces/a/channels/c3/MEMORY.md", `## Facts\n- ${"clipword ".repeat(400)}tailword\n`);
  syncIndex(s.db, s.home, "a");
  expect(s.find("a", "bigword")).toEqual([]);
  expect(
    s.db
      .query(
        "SELECT count(*) AS c FROM memory_fts WHERE source = 'channel' AND id LIKE 'channel/c2%'",
      )
      .get(),
  ).toEqual({ c: INDEX_MAX_CHUNKS_PER_FILE });
  expect(s.find("a", "item0", { channel: "c2" })).toEqual([]); // oldest dropped
  expect(s.find("a", "tailword", { channel: "c3" })).toEqual([]); // clipped at CHUNK_MAX_CHARS
  expect(s.find("a", "clipword", { channel: "c3" })[0]?.snippet.length).toBeLessThanOrEqual(200);
  expect(CHUNK_MAX_CHARS).toBe(1200);
  saveSummary(s.db, "gone", "a", "summaryword");
  syncIndex(s.db, s.home, "a");
  expect(s.find("a", "summaryword")).toHaveLength(1);
  s.db.query("DELETE FROM thread_summaries").run();
  syncIndex(s.db, s.home, "a");
  expect(s.find("a", "summaryword")).toEqual([]);
});

test("sync purges index rows of retired workspace and location files (they no longer classify)", () => {
  const s = setup();
  const ws = s.put("workspaces/a/MEMORY.md", MEM("- oldlayerword"));
  const loc = s.put("workspaces/a/locations/api/MEMORY.md", MEM("- oldlayerword"));
  // Rows as an older build left them: the files exist, but their paths are not indexable now.
  for (const [path, id, source] of [
    [ws, "workspace#Decisions:1~abcdef", "workspace"],
    [loc, "location/api#Decisions:1~abcdef", "location"],
  ] as const) {
    s.db
      .query("INSERT INTO memory_files (path, workspace, mtime_ms, size) VALUES (?, 'a', 1, 1)")
      .run(path);
    s.db
      .query(
        "INSERT INTO memory_fts (text, orig, id, source, section, kind, date, workspace, path) VALUES ('oldlayerword', 'oldlayerword', ?, ?, 'Decisions', 'decision', '2026-10-01', 'a', ?)",
      )
      .run(id, source, path);
  }
  expect(s.find("a", "oldlayerword")).toHaveLength(2);
  expect(syncIndex(s.db, s.home, "a").purged).toBe(2);
  expect(s.find("a", "oldlayerword")).toEqual([]);
});

test("journal isolation: two channels of one space write journals; a search in channel A never returns B hits", () => {
  const s = setup();
  for (const ch of ["c1", "c2"])
    s.put(
      `workspaces/a/channels/${ch}/memory/2026-10-13.md`,
      `## 09:00 t\n### Facts\n- okapi journal ${ch}\n`,
    );
  syncAll(s.db, s.home);
  const hits = (channel: string | undefined) =>
    searchIndex(s.db, "a", { query: "okapi", limit: 20, channel }).hits;
  const ids = (channel: string) => hits(channel).map((h) => h.id);
  expect(ids("c1")).toHaveLength(1);
  expect(ids("c1")[0]).toStartWith("journal/c1/2026-10-13#09:00:1~");
  expect(ids("c2")[0]).toStartWith("journal/c2/");
  expect(hits(undefined)).toEqual([]); // a run without a channel sees no journal
  expect(
    searchIndex(s.db, "a", { query: "okapi", limit: 20, channel: "c", scope: "journal" }).hits,
  ).toEqual([]);
});
