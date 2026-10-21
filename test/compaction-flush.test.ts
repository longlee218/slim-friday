import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FLUSH_INPUT_MAX_CHARS, FLUSH_MAX_ITEMS } from "../src/config/memory-caps";
import { type FlushRequest, flushAfterCompaction } from "../src/memory/compaction-flush";
import { appendJournalBlock, journalFile } from "../src/memory/daily-journal";
import { searchIndex } from "../src/memory/index/memory-search";
import type { CompactLlm } from "../src/memory/memory-compaction-llm";
import { emptyUsage } from "../src/observability/run-usage";
import { FLUSH_SYSTEM } from "../src/roles/prompts/memory-prompts";
import { openDb } from "../src/storage/db";
import { bumpCycle, getThreadSummary } from "../src/storage/thread-summary-store";

const NOW = new Date(2026, 9, 21, 9, 5);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Real db + temp home; the thread is on a compaction cycle that needs a flush. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "compaction-flush-"));
  dirs.push(home);
  const db = openDb(":memory:");
  bumpCycle(db, "thread-abc123", "a");
  const journal = () => journalFile(home, "a", "ops", "2026-10-21");
  return { home, db, journal };
}

const req = (over: Partial<FlushRequest> = {}): FlushRequest => ({
  threadId: "thread-abc123",
  workspace: "a",
  channel: "ops",
  cycle: 1,
  summary: "We talked about the store.",
  tail: [{ role: "user", text: "We decided to use Postgres for the store." }],
  ...over,
});

/** Fake model call: records the inputs, answers with `reply` or throws. */
function fakeLlm(reply: string | Error) {
  const calls: { system: string; prompt: string }[] = [];
  const llm: CompactLlm = async (system, prompt) => {
    calls.push({ system, prompt });
    if (reply instanceof Error) throw reply;
    return { text: reply, usage: emptyUsage() };
  };
  return { llm, calls };
}

test("llm reply: one journal block, cycle marked flushed, file searchable", async () => {
  const s = setup();
  const f = fakeLlm(
    '```json\n{"items":[{"kind":"decision","text":"Use Postgres for the store."},{"kind":"open","text":"Pick a backup plan."}]}\n```',
  );
  const res = await flushAfterCompaction(
    { db: s.db, home: s.home, llm: f.llm, now: () => NOW },
    req(),
  );
  expect(res).toEqual({ mode: "llm", items: 2, saved: 2 });
  const text = readFileSync(s.journal(), "utf8");
  expect(text).toContain(
    "## 09:05 Flush - thread abc123\n### Decisions\n- Use Postgres for the store. (2026-10-21)",
  );
  expect(text).toContain("### Open\n- Pick a backup plan.");
  expect(f.calls[0]?.system).toBe(FLUSH_SYSTEM);
  expect(f.calls[0]?.prompt).toContain("We talked about the store.");
  expect(f.calls[0]?.prompt).toContain("user: We decided to use Postgres");
  const row = getThreadSummary(s.db, "thread-abc123");
  expect(row?.flushed_cycle).toBe(row?.cycle ?? -1);
  expect(
    searchIndex(s.db, "a", { query: "postgres", limit: 5, channel: "ops" }).hits[0]?.source,
  ).toBe("journal");
});

test("a second flush of the same cycle is skipped (no model call, no write)", async () => {
  const s = setup();
  const f = fakeLlm('{"items":[{"kind":"fact","text":"The store is Postgres."}]}');
  const d = { db: s.db, home: s.home, llm: f.llm, now: () => NOW };
  await flushAfterCompaction(d, req());
  const before = readFileSync(s.journal(), "utf8");
  expect((await flushAfterCompaction(d, req())).mode).toBe("skipped");
  expect(f.calls).toHaveLength(1);
  expect(readFileSync(s.journal(), "utf8")).toBe(before);
  // The next compaction is a new cycle: flushed again.
  bumpCycle(s.db, "thread-abc123", "a");
  expect((await flushAfterCompaction(d, req({ cycle: 2 }))).mode).not.toBe("skipped");
  expect(f.calls).toHaveLength(2);
});

test("bad JSON and an unknown kind fall back to the keyword extract", async () => {
  for (const reply of ["sorry, no list", '{"items":[{"kind":"gossip","text":"x"}]}']) {
    const s = setup();
    const res = await flushAfterCompaction(
      { db: s.db, home: s.home, llm: fakeLlm(reply).llm, now: () => NOW },
      req(),
    );
    expect(res.mode).toBe("fallback");
    expect(res.saved).toBeGreaterThan(0);
    expect(readFileSync(s.journal(), "utf8")).toContain(
      "We decided to use Postgres for the store.",
    );
  }
});

test("a model error falls back to the extract, which reads the summary too", async () => {
  const s = setup();
  const res = await flushAfterCompaction(
    { db: s.db, home: s.home, llm: fakeLlm(new Error("overloaded")).llm, now: () => NOW },
    req({ summary: "The worker requires a restart after deploy." }),
  );
  expect(res.mode).toBe("fallback");
  const text = readFileSync(s.journal(), "utf8");
  expect(text).toContain("The worker requires a restart after deploy.");
  expect(text).toContain("We decided to use Postgres for the store.");
});

test("nothing durable: mode none, no file, cycle still marked flushed", async () => {
  const s = setup();
  const res = await flushAfterCompaction(
    { db: s.db, home: s.home, llm: fakeLlm('{"items":[]}').llm, now: () => NOW },
    req(),
  );
  expect(res).toEqual({ mode: "none", items: 0, saved: 0 });
  expect(existsSync(s.journal())).toBe(false);
  const row = getThreadSummary(s.db, "thread-abc123");
  expect(row?.flushed_cycle).toBe(row?.cycle ?? -1);
  // Empty LLM list is not a fallback trigger; a fallback with nothing matched is none too.
  const s2 = setup();
  const r2 = await flushAfterCompaction(
    { db: s2.db, home: s2.home, llm: fakeLlm(new Error("x")).llm, now: () => NOW },
    req({ summary: "", tail: [{ role: "user", text: "ok thanks" }] }),
  );
  expect(r2.mode).toBe("none");
});

test("the list is cut to FLUSH_MAX_ITEMS, secrets are masked, the input is clipped, no channel writes nothing", async () => {
  const s = setup();
  const items = Array.from({ length: FLUSH_MAX_ITEMS + 5 }, (_, i) => ({
    kind: "fact",
    text: `Fact number ${i} about the store`,
  }));
  items[0] = {
    kind: "fact",
    text: "Key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 for the store",
  };
  const f = fakeLlm(JSON.stringify({ items }));
  const big = "x".repeat(FLUSH_INPUT_MAX_CHARS * 2);
  const res = await flushAfterCompaction(
    { db: s.db, home: s.home, llm: f.llm, now: () => NOW },
    req({ summary: big }),
  );
  expect(res.items).toBe(FLUSH_MAX_ITEMS);
  expect(f.calls[0]?.prompt.length).toBeLessThanOrEqual(FLUSH_INPUT_MAX_CHARS);
  const text = readFileSync(s.journal(), "utf8");
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain("abcdefghijkl");

  const s2 = setup();
  const r2 = await flushAfterCompaction(
    {
      db: s2.db,
      home: s2.home,
      llm: fakeLlm('{"items":[{"kind":"fact","text":"A note."}]}').llm,
      now: () => NOW,
    },
    req({ channel: undefined }),
  );
  expect(r2.saved).toBe(0);
  expect(existsSync(s2.journal())).toBe(false);
});

test("compaction N+1 queued while flush N runs is not skipped (cycle in the request)", async () => {
  const s = setup(); // cycle 1
  bumpCycle(s.db, "thread-abc123", "a"); // cycle 2 happened before flush 1 ran
  const f = fakeLlm('{"items":[{"kind":"fact","text":"The store is Postgres."}]}');
  const d = { db: s.db, home: s.home, llm: f.llm, now: () => NOW };
  expect((await flushAfterCompaction(d, req({ cycle: 1 }))).mode).toBe("llm");
  expect(getThreadSummary(s.db, "thread-abc123")?.flushed_cycle).toBe(1);
  const second = await flushAfterCompaction(d, req({ cycle: 2 }));
  expect(second.mode).not.toBe("skipped");
  expect(getThreadSummary(s.db, "thread-abc123")?.flushed_cycle).toBe(2);
});

test("busy journal lock: cycle stays unflushed and a retry writes it", async () => {
  const s = setup();
  const d = {
    db: s.db,
    home: s.home,
    llm: fakeLlm('{"items":[{"kind":"fact","text":"A note."}]}').llm,
    now: () => NOW,
  };
  // A live, fresh lock on the day file: the writer waits its 5 s, then reports busy.
  mkdirSync(dirname(s.journal()), { recursive: true });
  writeFileSync(`${s.journal()}.lock`, String(process.pid));
  const res = await flushAfterCompaction(d, req());
  expect(res.saved).toBe(0);
  expect(getThreadSummary(s.db, "thread-abc123")?.flushed_cycle).toBe(-1);
  rmSync(`${s.journal()}.lock`);
  expect((await flushAfterCompaction(d, req())).saved).toBe(1); // retry works once the lock is free
  expect(getThreadSummary(s.db, "thread-abc123")?.flushed_cycle).toBe(1);
}, 15_000);

test("a full day file is marked flushed (no endless retry)", async () => {
  const s = setup();
  mkdirSync(dirname(s.journal()), { recursive: true });
  writeFileSync(s.journal(), `# Journal 2026-10-21\n${"- filler line\n".repeat(305)}`);
  const res = await flushAfterCompaction(
    {
      db: s.db,
      home: s.home,
      llm: fakeLlm('{"items":[{"kind":"fact","text":"A brand new note."}]}').llm,
      now: () => NOW,
    },
    req(),
  );
  expect(res.saved).toBe(0);
  expect(getThreadSummary(s.db, "thread-abc123")?.flushed_cycle).toBe(1);
});

test("the journal dedupe runs under the lock: the same note from two labels is written once", () => {
  const s = setup();
  const base = { home: s.home, workspace: "a", channel: "ops", now: NOW };
  const items = [{ kind: "fact" as const, text: "The store is Postgres." }];
  expect(appendJournalBlock({ ...base, label: "Flush - thread aaaaaa", items }).saved).toBe(1);
  expect(appendJournalBlock({ ...base, label: "Flush - thread bbbbbb", items }).saved).toBe(0);
  expect(readFileSync(s.journal(), "utf8").match(/The store is Postgres/g)).toHaveLength(1);
});

test("shutdown abort ends the model call; the flush writes the keyword extract of its tail", async () => {
  const s = setup();
  const ac = new AbortController();
  const llm: CompactLlm = (_s, _p, signal) =>
    new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  const run = flushAfterCompaction(
    { db: s.db, home: s.home, llm, now: () => NOW, signal: ac.signal },
    req(),
  );
  ac.abort();
  const res = await run;
  expect(res.mode).toBe("fallback");
  expect(readFileSync(s.journal(), "utf8")).toContain("We decided to use Postgres");
});

test("secrets in summary and tail are masked before the model sees them", async () => {
  const s = setup();
  const f = fakeLlm('{"items":[]}');
  await flushAfterCompaction(
    { db: s.db, home: s.home, llm: f.llm, now: () => NOW },
    req({
      summary: "Token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 was shared.",
      tail: [{ role: "user", text: "API_KEY=supersecretvalue99" }],
    }),
  );
  const prompt = f.calls[0]?.prompt ?? "";
  expect(prompt).toContain("[REDACTED]");
  expect(prompt).not.toContain("abcdefghijkl");
  expect(prompt).not.toContain("supersecretvalue99");
});

test("one invalid kind drops that note only; all invalid falls back", async () => {
  const s = setup();
  const res = await flushAfterCompaction(
    {
      db: s.db,
      home: s.home,
      llm: fakeLlm(
        '{"items":[{"kind":"gossip","text":"x"},{"kind":"fact","text":"The store is Postgres."}]}',
      ).llm,
      now: () => NOW,
    },
    req(),
  );
  expect(res).toEqual({ mode: "llm", items: 1, saved: 1 });
});

test("a lesson item without cue and evidence is dropped; a structured one is kept", async () => {
  const s = setup();
  const f = fakeLlm(
    JSON.stringify({
      items: [
        { kind: "lesson", text: "Always run migrations." },
        {
          kind: "lesson",
          text: "When tests hit a missing table: run migrations first — evidence: owner message 09:01",
        },
      ],
    }),
  );
  const res = await flushAfterCompaction(
    { db: s.db, home: s.home, llm: f.llm, now: () => NOW },
    req(),
  );
  expect(res).toMatchObject({ mode: "llm", items: 1 });
  const text = readFileSync(s.journal(), "utf8");
  expect(text).toContain("When tests hit a missing table: run migrations first — evidence:");
  expect(text).not.toContain("Always run migrations.");
});
