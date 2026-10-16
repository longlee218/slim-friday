import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HAIKU_MODEL } from "../src/config/model-ids";
import { appendJournalBlock, journalFile, pruneJournals } from "../src/memory/daily-journal";
import {
  EXTRACT_ITEM_CHARS,
  EXTRACT_MAX_ITEMS,
  extractContext,
} from "../src/memory/extract-context";
import { searchIndex } from "../src/memory/index/memory-search";
import { syncIndex } from "../src/memory/index/memory-sync";
import { buildPromptContext } from "../src/memory/prompt-context";
import { mergeSummary } from "../src/memory/summary-merge";
import { runRole } from "../src/orchestrator/run/run-role";
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
  const hooks = buildCompactHooks({
    db,
    home,
    workspace: "a",
    locationNames: () => [],
    threadId: "th1",
    trackSummary,
    threadLabel: "thread t1",
    now: () => NOW,
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
  const journal = () => journalFile(home, "a", "2026-10-13");
  const search = (q: string) => searchIndex(db, "a", { query: q, limit: 5, locations: [] }).hits;
  return { home, db, pre, post, transcript, journal, search };
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

test("PreCompact: journal gets the Extracted Context block under the local date, tool results excluded, searchable", async () => {
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
  const out = await s.pre({ transcript_path: path });
  expect(out).toEqual({ continue: true });
  const text = readFileSync(s.journal(), "utf8");
  expect(text).toContain("# Journal 2026-10-13");
  expect(text).toContain(
    "## 14:32 Extracted Context - thread t1\n### Decisions\n- We decided to use Postgres for the store. (2026-10-13)",
  );
  expect(text).toContain("### Facts\n- The worker requires a restart after deploy. (2026-10-13)");
  expect(text).toContain("### Preferences\n- Luôn viết test trước. (2026-10-13)");
  expect(text).not.toContain("zebra");
  expect(text).not.toContain("quokka");
  // The hook re-indexed the file: MemorySearch finds the block without a sync.
  expect(s.search("postgres")[0]?.source).toBe("journal");
  // The keyword extract is not the flush: no cycle counter is touched.
  expect(getThreadSummary(s.db, "th1")).toBeNull();
  // A second compaction over the same tail adds nothing (same notes already in the day file).
  await s.pre({ transcript_path: path });
  expect(readFileSync(s.journal(), "utf8")).toBe(text);
});

test("PreCompact: no match writes nothing; unreadable transcript and subagent calls are harmless", async () => {
  const s = setup();
  const quiet = s.transcript([user("hello there"), asst("hi, how can I help")]);
  expect(await s.pre({ transcript_path: quiet })).toEqual({ continue: true });
  expect(existsSync(s.journal())).toBe(false);
  expect(await s.pre({ transcript_path: join(s.home, "missing.jsonl") })).toEqual({
    continue: true,
  });
  const loud = s.transcript([user("We decided to use Bun.")]);
  expect(await s.pre({ transcript_path: loud, agent_id: "sub1" })).toEqual({ continue: true });
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
  expect(existsSync(s.journal())).toBe(false);
});

test("PostCompact is incremental: a new summary that does not cover the old one is merged, one that does is kept as is", async () => {
  const s = setup();
  saveSummary(
    s.db,
    "th1",
    "a",
    "Earlier work covered the kubernetes ingress rollout and certificate rotation.",
  );
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
  saveSummary(s.db, "th1", "a", "kept summary text");
  await s.post({ compact_summary: "subagent notes", agent_id: "sub1", agent_type: "explorer" });
  await s.post({ compact_summary: "   " });
  await s.post({});
  const row = getThreadSummary(s.db, "th1");
  expect(row?.summary).toBe("kept summary text");
  expect(row?.cycle).toBe(2); // only the two main-agent compactions counted
  expect(existsSync(s.journal())).toBe(false);
});

test("a background (dev) run journals the extract but never touches the thread summary", async () => {
  const s = setup(false);
  expect(s.post({ compact_summary: "dev summary" })).toBeUndefined(); // PostCompact not registered
  await s.pre({ transcript_path: s.transcript([user("We decided to use Bun.")]) });
  expect(getThreadSummary(s.db, "th1")).toBeNull();
  expect(readFileSync(s.journal(), "utf8")).toContain("We decided to use Bun.");
});

test("a pruned journal day is gone from MemorySearch after the startup prune and sync", () => {
  const s = setup();
  const dir = join(s.home, "workspaces", "a", "memory");
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
  });
});

test("journal: hook text is never injected into a prompt; the line limit stops appends; prune keeps recent day files", async () => {
  const s = setup();
  await s.pre({ transcript_path: s.transcript([user("We decided to use quarkus.")]) });
  const prompt = buildPromptContext({
    agentHome: s.home,
    workspace: "a",
    kind: "lead",
    registry: "",
    memoryLocations: [],
  });
  expect(JSON.stringify(prompt)).not.toContain("quarkus");

  writeFileSync(
    s.journal(),
    `# Journal\n## 10:00 x\n### Facts\n${Array.from({ length: 300 }, (_, n) => `- filler ${n}`).join("\n")}\n`,
  );
  const res = appendJournalBlock({
    home: s.home,
    workspace: "a",
    label: "t",
    items: [{ kind: "fact", text: "a brand new note" }],
    now: NOW,
  });
  expect(res.saved).toBe(0);
  expect(readFileSync(s.journal(), "utf8")).not.toContain("brand new");

  const dir = join(s.home, "workspaces", "a", "memory");
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
    kind: "lead",
    limits: { maxAsk: 3 },
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
      role: "lead",
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
        role: probe.name,
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

test("rollover context: PostCompact stores the SDK summary as is (no merge, no bump), PreCompact skips", async () => {
  const s = setup();
  saveSummary(s.db, "th1", "a", "old summary about parsers and caches");
  const got: string[] = [];
  const hooks = buildCompactHooks({
    db: s.db,
    home: s.home,
    workspace: "a",
    locationNames: () => [],
    threadId: "th1",
    trackSummary: true,
    threadLabel: "thread t1",
    now: () => NOW,
    rollover: { onSummary: (x) => got.push(x) },
  });
  const sig = { signal: new AbortController().signal };
  const file = s.transcript([user("We decided to use Postgres for the store.")]);
  await hooks.PreCompact?.[0]?.hooks[0]?.(
    {
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: null,
      transcript_path: file,
    } as never,
    undefined,
    sig,
  );
  expect(existsSync(s.journal())).toBe(false);
  await hooks.PostCompact?.[0]?.hooks[0]?.(
    {
      hook_event_name: "PostCompact",
      trigger: "manual",
      compact_summary: "fresh summary",
    } as never,
    undefined,
    sig,
  );
  expect(got).toEqual(["fresh summary"]);
  expect(getThreadSummary(s.db, "th1")).toMatchObject({ summary: "fresh summary", cycle: 0 });
});
