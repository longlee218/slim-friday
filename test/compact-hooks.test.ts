import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HAIKU_MODEL } from "../src/config/model-ids";
import type { FlushRequest } from "../src/memory/compaction-flush";
import { appendJournalBlock, journalFile, pruneJournals } from "../src/memory/daily-journal";
import {
  EXTRACT_ITEM_CHARS,
  EXTRACT_MAX_ITEMS,
  extractContext,
} from "../src/memory/extract-context";
import { searchIndex } from "../src/memory/index/memory-search";
import { syncIndex } from "../src/memory/index/memory-sync";
import { buildPromptContext } from "../src/memory/prompt-context";
import { RELATED_HEADING } from "../src/memory/related-heading";
import { mergeSummary } from "../src/memory/summary-merge";
import { runRole } from "../src/orchestrator/run/run-role";
import { COMPACT_INSTRUCTIONS } from "../src/roles/prompts/memory-prompts";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { buildCompactHooks } from "../src/runtime/compact-hooks";
import { openDb } from "../src/storage/db";
import { insertTurn } from "../src/storage/run-store";
import { getThreadSummary, saveSummary } from "../src/storage/thread-summary-store";
import { makeEnv, resultMsg, stubGateway } from "./helpers";

const NOW = new Date(2026, 9, 13, 14, 32);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Home + db + hook callbacks of workspace `a`, thread `th1`. */
function setup(trackSummary = true) {
  const home = mkdtempSync(join(tmpdir(), "compact-hooks-"));
  dirs.push(home);
  const db = openDb(":memory:");
  /** What PostCompact handed to the flush (`onCompacted`). */
  const compacted: FlushRequest[] = [];
  const hooks = buildCompactHooks({
    db,
    home,
    workspace: "a",
    channel: "ops",
    threadId: "th1",
    trackSummary,
    threadLabel: "thread t1",
    now: () => NOW,
    onCompacted: (e) => compacted.push(e),
  });
  const sig = { signal: new AbortController().signal };
  const pre = (i: Record<string, unknown>) =>
    hooks.PreCompact?.[0]?.hooks[0]?.(
      { hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null, ...i } as never,
      undefined,
      sig,
    );
  const post = (i: Record<string, unknown>) =>
    hooks.PostCompact?.[0]?.hooks[0]?.(
      { hook_event_name: "PostCompact", trigger: "auto", ...i } as never,
      undefined,
      sig,
    );
  /** Write a transcript JSONL; returns its path. */
  const transcript = (lines: unknown[]) => {
    const f = join(home, "t.jsonl");
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
    return f;
  };
  const journal = () => journalFile(home, "a", "ops", "2026-10-13");
  const search = (q: string) => searchIndex(db, "a", { query: q, limit: 5, channel: "ops" }).hits;
  return { home, db, hooks, compacted, pre, post, transcript, journal, search };
}

const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const asst = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

test("extractContext: English and Vietnamese sentences land in their buckets", () => {
  const e = extractContext([
    { role: "user", text: "We decided to use Postgres for the store. I always want small diffs." },
    {
      role: "user",
      text: "Chúng ta đã quyết định dùng Bun. Luôn viết test trước. Cổng yêu cầu port 8080.",
    },
    { role: "assistant", text: "The config requires a restart. Should we use Redis?" },
  ]);
  expect(e.decisions).toEqual([
    "We decided to use Postgres for the store.",
    "Chúng ta đã quyết định dùng Bun.",
  ]);
  expect(e.preferences).toEqual(["I always want small diffs.", "Luôn viết test trước."]);
  expect(e.facts).toEqual(["Cổng yêu cầu port 8080.", "The config requires a restart."]);
});

test("extractContext: preferences only from the owner, secrets masked, caps applied", () => {
  const e = extractContext([
    { role: "assistant", text: "I will never touch the schema without asking you." },
    {
      role: "user",
      text: "We decided to rotate the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 today.",
    },
    ...Array.from({ length: 12 }, (_, n) => ({
      role: "user" as const,
      text: `We decided on option number ${n} ${"x".repeat(300)}.`,
    })),
  ]);
  expect(e.preferences).toEqual([]);
  expect(e.decisions).toHaveLength(EXTRACT_MAX_ITEMS);
  expect(e.decisions.every((d) => d.length <= EXTRACT_ITEM_CHARS)).toBe(true);
  expect(e.decisions.at(-1)).toContain("option number 11"); // the newest are kept
  const secret = extractContext([
    {
      role: "user",
      text: "We decided to rotate the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 today.",
    },
  ]);
  expect(secret.decisions[0]).toContain("[REDACTED]");
  expect(secret.decisions[0]).not.toContain("abcdefghijkl");
});

test("PreCompact captures the chat tail without writing; PostCompact hands it to the flush (tool results and sidechains excluded)", async () => {
  const s = setup();
  const path = s.transcript([
    user("We decided to use Postgres for the store. Luôn viết test trước."),
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "We decided to leak tool output zebra." }],
      },
    },
    asst("The worker requires a restart after deploy."),
    { ...asst("We decided sidechain noise quokka."), isSidechain: true },
  ]);
  expect(await s.pre({ transcript_path: path })).toEqual({
    continue: true,
    systemMessage: COMPACT_INSTRUCTIONS,
  });
  // No write at PreCompact: no journal, no cycle.
  expect(existsSync(s.journal())).toBe(false);
  expect(getThreadSummary(s.db, "th1")).toBeNull();
  expect(s.compacted).toHaveLength(0);
  await s.post({ compact_summary: "Billing moved." });
  expect(s.compacted).toHaveLength(1);
  const e = s.compacted[0] as FlushRequest;
  expect(e).toMatchObject({
    threadId: "th1",
    workspace: "a",
    channel: "ops",
    summary: "Billing moved.",
  });
  const text = e.tail.map((m) => m.text).join("\n");
  expect(text).toContain("We decided to use Postgres for the store.");
  expect(text).toContain("The worker requires a restart after deploy.");
  expect(text).not.toContain("zebra");
  expect(text).not.toContain("quokka");
  // The tail is handed over once: a compaction without a PreCompact carries none.
  await s.post({ compact_summary: "Again." });
  expect(s.compacted[1]?.tail).toEqual([]);
});

test("PreCompact: an unreadable transcript is harmless (empty tail, the flush still runs); subagent calls are ignored", async () => {
  const s = setup();
  expect(await s.pre({ transcript_path: join(s.home, "missing.jsonl") })).toEqual({
    continue: true,
    systemMessage: COMPACT_INSTRUCTIONS,
  });
  const loud = s.transcript([user("We decided to use Bun.")]);
  expect(await s.pre({ transcript_path: loud, agent_id: "sub1" })).toEqual({ continue: true });
  await s.post({ compact_summary: "S" });
  expect(s.compacted[0]?.tail).toEqual([]);
  expect(existsSync(s.journal())).toBe(false);
});

test("PostCompact: first summary is stored as is, cycle +1, indexed once, no journal entry", async () => {
  const s = setup();
  expect(await s.post({ compact_summary: "We migrated billing to the quarkus service." })).toEqual({
    continue: true,
  });
  const row = getThreadSummary(s.db, "th1");
  expect(row?.summary).toBe("We migrated billing to the quarkus service.");
  expect(row?.workspace).toBe("a");
  expect(row?.cycle).toBe(1);
  expect(s.search("quarkus").map((h) => h.source)).toEqual(["summary"]);
  expect(s.compacted.map((e) => e.summary)).toEqual([
    "We migrated billing to the quarkus service.",
  ]);
  expect(existsSync(s.journal())).toBe(false);
});

test("PostCompact is incremental: a new summary that does not cover the old one is merged, one that does is kept as is", async () => {
  const s = setup();
  saveSummary(s.db, {
    threadId: "th1",
    workspace: "a",
    channel: "ops",
    summary: "Earlier work covered the kubernetes ingress rollout and certificate rotation.",
    source: "compaction",
  });
  await s.post({
    compact_summary: "Then the team debugged flaky integration tests in the billing pipeline.",
  });
  expect(getThreadSummary(s.db, "th1")?.summary).toBe(
    "Earlier: Earlier work covered the kubernetes ingress rollout and certificate rotation.\n\nLatest: Then the team debugged flaky integration tests in the billing pipeline.",
  );
  // A resumed session restates the previous summary: no duplicated text.
  const restated =
    "Kubernetes ingress rollout and certificate rotation were covered earlier; flaky integration tests in the billing pipeline were debugged, then deployment finished.";
  await s.post({ compact_summary: restated });
  expect(getThreadSummary(s.db, "th1")?.summary).toBe(restated);
  expect(getThreadSummary(s.db, "th1")?.cycle).toBe(2);
});

test("mergeSummary: labels never nest, the old part is clipped first and the result fits the limit", () => {
  const merged = mergeSummary(
    "Earlier: alpha bravo charlie\n\nLatest: delta echo foxtrot",
    "golf hotel india juliet kilo",
  );
  expect(merged).toBe(
    "Earlier: alpha bravo charlie\n\ndelta echo foxtrot\n\nLatest: golf hotel india juliet kilo",
  );
  const long = mergeSummary(`${"oldword ".repeat(1000)}`, `${"fresh ".repeat(1000)} newest`);
  expect(long.length).toBeLessThanOrEqual(8000);
  expect(long.endsWith("newest")).toBe(true);
  expect(mergeSummary("", "only new")).toBe("only new");
});

test("PostCompact: a subagent compaction never touches the thread summary; an empty summary keeps the old one but still counts the cycle", async () => {
  const s = setup();
  saveSummary(s.db, {
    threadId: "th1",
    workspace: "a",
    channel: "ops",
    summary: "kept summary text",
    source: "compaction",
  });
  await s.post({ compact_summary: "subagent notes", agent_id: "sub1", agent_type: "explorer" });
  await s.post({ compact_summary: "   " });
  await s.post({});
  const row = getThreadSummary(s.db, "th1");
  expect(row?.summary).toBe("kept summary text");
  expect(row?.cycle).toBe(2); // only the two main-agent compactions counted
  // The flush is scheduled for each of them (no summary = the tail only), never for the subagent's.
  expect(s.compacted.map((e) => e.summary)).toEqual(["", ""]);
  expect(existsSync(s.journal())).toBe(false);
});

test("a background (worker) run registers no compaction hook: no summary, no journal, no flush", async () => {
  const s = setup(false);
  expect(s.hooks).toEqual({});
  expect(getThreadSummary(s.db, "th1")).toBeNull();
  expect(s.compacted).toHaveLength(0);
  expect(existsSync(s.journal())).toBe(false);
});

test("a pruned journal day is gone from MemorySearch after the startup prune and sync", () => {
  const s = setup();
  const dir = join(s.home, "workspaces", "a", "channels", "ops", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-08-01.md"),
    "# J\n## 10:00 x\n### Facts\n- the zebra deploy failed\n",
  );
  syncIndex(s.db, s.home, "a");
  expect(s.search("zebra")).toHaveLength(1);
  pruneJournals(s.home, NOW);
  syncIndex(s.db, s.home, "a");
  expect(s.search("zebra")).toHaveLength(0);
});

test("hook errors never reach the run", async () => {
  const s = setup();
  s.db.close();
  expect(await s.post({ compact_summary: "some summary" })).toEqual({ continue: true });
  expect(await s.pre({ transcript_path: s.transcript([user("We decided to use Bun.")]) })).toEqual({
    continue: true,
    systemMessage: COMPACT_INSTRUCTIONS,
  });
});

test("PreCompact returns the what-to-keep text as systemMessage (the SDK appends it to custom_instructions); no secrets, short; a worker run has no hook", async () => {
  const s = setup();
  const out = (await s.pre({
    transcript_path: join(s.home, "missing.jsonl"),
    trigger: "manual",
    custom_instructions: "focus on code",
  })) as { continue: boolean; systemMessage: string };
  // The caller's custom_instructions are merged by the SDK, so ours must not echo them.
  expect(out.systemMessage).toBe(COMPACT_INSTRUCTIONS);
  expect(out.systemMessage).not.toContain("focus on code");
  expect(COMPACT_INSTRUCTIONS.length).toBeLessThan(1200);
  expect(COMPACT_INSTRUCTIONS).toContain("owner decisions");
  expect(COMPACT_INSTRUCTIONS).toContain(RELATED_HEADING); // the injected per-turn block is not summarized
  expect(setup(false).hooks).toEqual({});
});

test("journal: hook text is never injected into a prompt; the line limit stops appends; prune keeps recent day files", async () => {
  const s = setup();
  appendJournalBlock({
    home: s.home,
    workspace: "a",
    channel: "ops",
    label: "Flush - thread t1",
    items: [{ kind: "decision", text: "We decided to use quarkus." }],
    now: NOW,
  });
  const prompt = buildPromptContext({
    agentHome: s.home,
    workspace: "a",
    kind: "teammate",
    registry: "",
  });
  expect(JSON.stringify(prompt)).not.toContain("quarkus");

  writeFileSync(
    s.journal(),
    `# Journal\n## 10:00 x\n### Facts\n${Array.from({ length: 300 }, (_, n) => `- filler ${n}`).join("\n")}\n`,
  );
  const res = appendJournalBlock({
    home: s.home,
    workspace: "a",
    channel: "ops",
    label: "t",
    items: [{ kind: "fact", text: "a brand new note" }],
    now: NOW,
  });
  expect(res.saved).toBe(0);
  expect(readFileSync(s.journal(), "utf8")).not.toContain("brand new");

  const dir = join(s.home, "workspaces", "a", "channels", "ops", "memory");
  for (const n of ["2026-08-01.md", "2026-10-01.md", "notes.md"]) writeFileSync(join(dir, n), "x");
  expect(pruneJournals(s.home, NOW)).toBe(1);
  expect(existsSync(join(dir, "2026-08-01.md"))).toBe(false);
  expect(existsSync(join(dir, "2026-10-01.md"))).toBe(true);
  expect(existsSync(join(dir, "notes.md"))).toBe(true);
});

test("every role run registers the PreCompact and PostCompact hooks", async () => {
  const env = makeEnv();
  const probe: RoleDefinition = {
    name: "probe-hooks",
    whenToUse: "test only",
    kind: "teammate",
    limits: { maxTurns: 20 },
    subagents: { parallel: 3, depth: 1 },
    sideEffects: "none",
    capabilities: ["read"],
    model: HAIKU_MODEL,
    budgetUsd: 0.4,
    promptSections: () => ["probe"],
  };
  const roles = ROLES as Record<string, RoleDefinition>;
  roles[probe.name] = probe;
  const seen: any[] = [];
  try {
    insertTurn(env.db, {
      id: "t1",
      threadId: "th",
      source: "test",
      location: "location",
      role: "chief-of-staff",
    });
    await runRole(
      {
        db: env.db,
        config: env.config,
        approvals: stubGateway(),
        queryFn: ((a: { options: unknown }) => {
          seen.push(a.options);
          return (async function* () {
            yield resultMsg({ result: "ok" });
          })();
        }) as never,
      },
      {
        turnId: "t1",
        threadId: "th",
        text: "hi",
        role: probe,
        workspace: "main",
        locations: [{ name: "location", path: env.location } as never],
        ac: new AbortController(),
      },
    );
  } finally {
    delete roles[probe.name];
  }
  expect(seen[0].hooks.PreCompact).toHaveLength(1);
  expect(seen[0].hooks.PostCompact).toHaveLength(1);
});

test("pruneJournals clears old day files of every channel and of the retired per-space dir; recent files stay", () => {
  const s = setup();
  const base = join(s.home, "workspaces", "a");
  const dirs = [
    join(base, "channels", "ops", "memory"),
    join(base, "channels", "dev", "memory"),
    join(base, "memory"),
  ];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "2026-08-01.md"), "x");
    writeFileSync(join(d, "2026-10-12.md"), "x");
  }
  expect(pruneJournals(s.home, NOW)).toBe(3);
  for (const d of dirs) {
    expect(existsSync(join(d, "2026-08-01.md"))).toBe(false);
    expect(existsSync(join(d, "2026-10-12.md"))).toBe(true);
  }
});
