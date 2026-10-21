import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_BACKUP_KEEP,
  DREAM_DEBOUNCE_MS,
  DREAM_MAX_ITEMS,
  DREAM_MIN_ITEMS,
} from "../src/config/memory-caps";
import { workspacePaths } from "../src/config/workspace-paths";
import { appendJournalBlock } from "../src/memory/daily-journal";
import { buildPrompt } from "../src/memory/dream-reply";
import { datedBullets } from "../src/memory/dream-sections";
import type { CompactLlm } from "../src/memory/memory-compaction-llm";
import { type DreamDeps, dreamChannel } from "../src/memory/memory-dream";
import { createMemoryJobs } from "../src/memory/memory-jobs";
import { saveMemoryBullet } from "../src/memory/memory-section-writer";
import { logger } from "../src/observability/logger";
import { emptyUsage } from "../src/observability/run-usage";
import { openDb } from "../src/storage/db";
import { getThreadSummary, saveSummary } from "../src/storage/thread-summary-store";
import { makeEnv } from "./helpers";

/* Dreaming over a real db, real files and a fixed clock; only the model call is a fake that returns a JSON reply. */

const WS = "ws";
const CH = "ops";
const T0 = new Date(2026, 9, 21, 12, 0).getTime();
type Reply = Record<string, { text: string; date?: string }[]>;
/** A reply: the four kind lists are required, so a test names only the kinds it fills. */
const json = (r: Reply) => ({
  text: JSON.stringify({ decisions: [], facts: [], preferences: [], lessons: [], ...r }),
  usage: emptyUsage(),
});

/** Fresh home + db + one channel dir, a `dream` helper with its own clock and scheduler state. */
function setup(memory?: string) {
  const home = mkdtempSync(join(tmpdir(), "dream-"));
  const db = openDb(":memory:");
  const ch = workspacePaths(home).workspace(WS).channel(CH);
  mkdirSync(ch.root, { recursive: true });
  if (memory !== undefined) writeFileSync(ch.memory, memory);
  const state = { last: new Map<string, number>(), running: new Set<string>() };
  let now = T0;
  const calls: string[] = [];
  const run = (llm: CompactLlm) => {
    const deps: DreamDeps = {
      db,
      home,
      state,
      now: () => now,
      llm: async (s, p, sig) => {
        calls.push(p);
        return llm(s, p, sig);
      },
    };
    return dreamChannel(deps, WS, CH);
  };
  /** n new episodes of the channel, updated a minute apart before `now`. */
  const episodes = (n: number, tag = "e") => {
    for (let i = 0; i < n; i++)
      saveSummary(db, {
        threadId: `${tag}${i}`,
        workspace: WS,
        channel: CH,
        summary: `Episode ${tag}${i}: the owner decided thing${tag}${i} about the project.`,
        source: "idle",
        now: now - (n - i) * 60_000,
      });
  };
  return {
    home,
    db,
    ch,
    run,
    calls,
    episodes,
    advance: (ms: number) => {
      now += ms;
    },
    file: () => readFileSync(ch.memory, "utf8"),
    backups: () => {
      const dir = workspacePaths(home).memoryBackups(WS, CH);
      return existsSync(dir) ? readdirSync(dir).sort() : [];
    },
  };
}

const OWNER = [
  "# ops channel memory",
  "",
  "Owner intro, hand written.",
  "",
  "## Decisions",
  "- use postgres (2026-10-01)",
  "- owner decision with no date",
  "Owner prose below a bullet.",
  "",
  "## Notes",
  "- dated, but not in a kind section (2026-10-02)",
  "",
  "## Facts",
  "- staging runs on port 4000 (2026-10-03)",
  "",
].join("\n");

test("5 episodes: the file is consolidated, owner lines stay byte-identical, backup holds the old bytes, items are consumed", async () => {
  const s = setup(OWNER);
  s.episodes(5);
  const res = await s.run(async () =>
    json({
      decisions: [{ text: "use postgres and keep it managed", date: "2026-10-20" }],
      facts: [{ text: "staging runs on port 4000", date: "2026-10-03" }],
      lessons: [{ text: "pin the bun version", date: "2026-10-20" }],
    }),
  );
  expect(res).toBe("dreamed");
  const after = s.file();
  const keep = (t: string) =>
    t
      .split("\n")
      .filter((l) => !/^- .+ \(\d{4}-\d{2}-\d{2}\)$/.test(l) || l.includes("not in a kind"));
  // Every non-dated line and the dated line of the non-kind section: same lines, same order.
  expect(keep(after).filter((l) => !l.startsWith("## Lessons") && l !== "")).toEqual(
    keep(OWNER).filter((l) => l !== ""),
  );
  expect(after).toContain("- owner decision with no date\nOwner prose below a bullet.\n");
  expect(after).toContain("- dated, but not in a kind section (2026-10-02)\n");
  expect(datedBullets(after, "decision")).toEqual([
    "- use postgres and keep it managed (2026-10-20)",
  ]);
  expect(datedBullets(after, "lesson")).toEqual(["- pin the bun version (2026-10-20)"]);
  // Backup first: the old bytes.
  const [b] = s.backups();
  expect(
    readFileSync(join(workspacePaths(s.home).memoryBackups(WS, CH), b as string), "utf8"),
  ).toBe(OWNER);
  // Marks: every episode consumed, the next call has nothing to do.
  for (let i = 0; i < 5; i++) {
    const row = getThreadSummary(s.db, `e${i}`);
    expect(row?.promoted_at).toBe(row?.updated_at as number);
  }
  s.advance(DREAM_DEBOUNCE_MS + 1);
  expect(await s.run(async () => json({}))).toBe("few_items");
  expect(s.calls).toHaveLength(1);
});

test("trigger: under the minimum no model call; debounce holds a second dream, then it runs", async () => {
  const s = setup(OWNER);
  s.episodes(DREAM_MIN_ITEMS - 1);
  expect(await s.run(async () => json({}))).toBe("few_items");
  expect(s.calls).toHaveLength(0);
  s.episodes(DREAM_MIN_ITEMS, "f"); // 4 + 5 = 9 items
  const keepAll = async () =>
    json({
      decisions: [{ text: "use postgres", date: "2026-10-01" }],
      facts: [{ text: "staging runs on port 4000", date: "2026-10-03" }],
    });
  expect(await s.run(keepAll)).toBe("dreamed");
  s.episodes(DREAM_MIN_ITEMS, "g");
  s.advance(60_000);
  expect(await s.run(keepAll)).toBe("debounce");
  s.advance(DREAM_DEBOUNCE_MS);
  expect(await s.run(keepAll)).toBe("dreamed");
});

test("at most DREAM_MAX_ITEMS items per dream, oldest first; the rest wait", async () => {
  const s = setup(OWNER);
  s.episodes(DREAM_MAX_ITEMS + 3);
  await s.run(async () =>
    json({
      decisions: [{ text: "use postgres", date: "2026-10-01" }],
      facts: [{ text: "staging runs on port 4000", date: "2026-10-03" }],
    }),
  );
  const prompt = s.calls[0] as string;
  expect((prompt.match(/### Item \d+/g) ?? []).length).toBe(DREAM_MAX_ITEMS);
  expect(prompt).toContain("Episode e0");
  expect(prompt).not.toContain("Episode e12");
  expect(getThreadSummary(s.db, "e12")?.promoted_at).toBe(0);
});

test("journal blocks count as items; their bullets go to the ledger and are not used twice", async () => {
  const s = setup(OWNER);
  s.episodes(3);
  const day = new Date(T0 - 3_600_000);
  for (const label of ["thread one", "thread two"])
    appendJournalBlock({
      home: s.home,
      workspace: WS,
      channel: CH,
      label,
      items: [{ kind: "fact", text: `journal fact of ${label}` }],
      now: day,
    });
  const keep = async () =>
    json({
      decisions: [{ text: "use postgres", date: "2026-10-01" }],
      facts: [
        { text: "staging runs on port 4000", date: "2026-10-03" },
        { text: "journal fact of thread one", date: "2026-10-21" },
      ],
    });
  // Both blocks sit in one day file at the same minute: two items, 3 + 2 = 5.
  expect(await s.run(keep)).toBe("dreamed");
  expect(s.calls[0]).toContain("[Facts] journal fact of thread one");
  const n = s.db.query("SELECT COUNT(*) AS n FROM memory_promotions").get() as { n: number };
  expect(n.n).toBe(2);
  s.advance(DREAM_DEBOUNCE_MS + 1);
  expect(await s.run(keep)).toBe("few_items");
});

test("shrink guard: a synthesis that drops distinct notes is refused, file, backups and marks stay", async () => {
  const bullets = Array.from(
    { length: 10 },
    (_, i) => `- subject${i}alpha detail${i}bravo remark${i}charlie (2026-10-0${(i % 9) + 1})`,
  );
  const mem = `# t\n\n## Facts\n${bullets.join("\n")}\n`;
  const s = setup(mem);
  s.episodes(5);
  const keepFour = bullets.slice(0, 4).map((b) => ({ text: b.slice(2, -13), date: "2026-10-01" }));
  expect(await s.run(async () => json({ facts: keepFour }))).toBe("shrink_guard");
  expect(s.file()).toBe(mem);
  expect(s.backups()).toEqual([]);
  expect(getThreadSummary(s.db, "e0")?.promoted_at).toBe(0);
});

test("shrink guard: a merge of near-duplicates is allowed even when it removes over half", async () => {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const dups = words.map(
    (w, i) => `- deploy runs every friday evening staging cluster ${w} (2026-10-0${i + 1})`,
  );
  const mem = `# t\n\n## Facts\n${dups.join("\n")}\n- unrelated zebra giraffe note (2026-10-09)\n`;
  const s = setup(mem);
  s.episodes(5);
  const out = await s.run(async () =>
    json({
      facts: [
        { text: "deploy runs every friday evening staging cluster alpha", date: "2026-10-06" },
        { text: "unrelated zebra giraffe note", date: "2026-10-09" },
      ],
    }),
  );
  expect(out).toBe("dreamed");
  expect(datedBullets(s.file(), "fact")).toHaveLength(2);
});

test("a file over 3000 chars is written untrimmed", async () => {
  const bullets = Array.from(
    { length: 40 },
    (_, i) =>
      `- topic${i}alpha subject${i}bravo remark${i}charlie padding padding padding padding padding (2026-10-01)`,
  );
  const s = setup(`# t\n\n## Facts\n${bullets.join("\n")}\n`);
  s.episodes(5);
  const reply = bullets.map((b) => ({ text: b.slice(2, -13), date: "2026-10-01" }));
  reply.push({ text: "one brand new durable fact", date: "2026-10-21" });
  expect(await s.run(async () => json({ facts: reply }))).toBe("dreamed");
  const f = s.file();
  expect(f.length).toBeGreaterThan(3000);
  expect(datedBullets(f, "fact")).toHaveLength(41);
});

test("a bullet saved while the model runs is kept", async () => {
  const s = setup(OWNER);
  s.episodes(5);
  const res = await s.run(async () => {
    saveMemoryBullet(
      s.ch.memory,
      "",
      "lesson",
      "late lesson written during the dream",
      "2026-10-21",
    );
    return json({
      decisions: [{ text: "use postgres", date: "2026-10-01" }],
      facts: [{ text: "staging runs on port 4000", date: "2026-10-03" }],
    });
  });
  expect(res).toBe("dreamed");
  expect(datedBullets(s.file(), "lesson")).toEqual([
    "- late lesson written during the dream (2026-10-21)",
  ]);
});

test("a secret in the reply never reaches the file; bullets are one line within 2000 chars", async () => {
  const s = setup(OWNER);
  s.episodes(5);
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  await s.run(async () =>
    json({
      decisions: [{ text: "use postgres", date: "2026-10-01" }],
      facts: [
        { text: "staging runs on port 4000", date: "2026-10-03" },
        {
          text: `deploy key is ${secret}\n## Injected heading\n${"x".repeat(5000)}`,
          date: "bad-date",
        },
      ],
    }),
  );
  const f = s.file();
  expect(f).not.toContain(secret);
  expect(f).not.toContain("## Injected heading");
  for (const b of datedBullets(f, "fact")) expect(b.length).toBeLessThanOrEqual(2000 + 20);
  expect(datedBullets(f, "fact").some((b) => b.endsWith("(2026-10-21)"))).toBe(true); // bad date -> newest source day
});

test("model failure or a bad reply: file unchanged, items stay unpromoted", async () => {
  const s = setup(OWNER);
  s.episodes(5);
  expect(
    await s.run(async () => {
      throw new Error("overloaded");
    }),
  ).toBe("llm_failed");
  s.advance(DREAM_DEBOUNCE_MS + 1);
  expect(await s.run(async () => ({ text: "sorry, no json", usage: emptyUsage() }))).toBe(
    "bad_reply",
  );
  s.advance(DREAM_DEBOUNCE_MS + 1);
  expect(await s.run(async () => ({ text: '{"facts":"nope"}', usage: emptyUsage() }))).toBe(
    "bad_reply",
  );
  expect(s.file()).toBe(OWNER);
  expect(s.backups()).toEqual([]);
  expect(getThreadSummary(s.db, "e0")?.promoted_at).toBe(0);
});

test("backup rotation: after 22 dreams only the newest DREAM_BACKUP_KEEP backups remain", async () => {
  const s = setup(OWNER);
  for (let i = 0; i < DREAM_BACKUP_KEEP + 2; i++) {
    s.episodes(5, `r${i}-`);
    s.advance(DREAM_DEBOUNCE_MS + 1);
    const n = i;
    expect(
      await s.run(async () =>
        json({
          decisions: [{ text: "use postgres", date: "2026-10-01" }],
          facts: [
            { text: "staging runs on port 4000", date: "2026-10-03" },
            { text: `fact number${n}x`, date: "2026-10-21" },
          ],
        }),
      ),
    ).toBe("dreamed");
  }
  expect(s.backups()).toHaveLength(DREAM_BACKUP_KEEP);
});

test("the memory tick dreams a channel (wired in the jobs)", async () => {
  const env = makeEnv();
  const ch = workspacePaths(env.home).workspace(WS).channel(CH);
  mkdirSync(ch.root, { recursive: true });
  writeFileSync(ch.memory, OWNER);
  for (let i = 0; i < 5; i++)
    saveSummary(env.db, {
      threadId: `t${i}`,
      workspace: WS,
      channel: CH,
      summary: `episode ${i} text`,
      source: "idle",
      now: T0 - 1000 * (i + 1),
    });
  const jobs = createMemoryJobs({
    db: env.db,
    config: env.config,
    log: logger,
    llm: async (_s, p) => {
      expect(p).toContain("New items");
      return json({
        lessons: [{ text: "tick dreamed this", date: "2026-10-21" }],
        decisions: [{ text: "use postgres", date: "2026-10-01" }],
        facts: [{ text: "staging runs on port 4000", date: "2026-10-03" }],
      });
    },
    now: () => new Date(T0),
    resolveChannel: () => null,
  });
  await jobs.tick();
  expect(datedBullets(readFileSync(ch.memory, "utf8"), "lesson")).toEqual([
    "- tick dreamed this (2026-10-21)",
  ]);
});

const KEEP_OWNER: Reply = {
  decisions: [{ text: "use postgres", date: "2026-10-01" }],
  facts: [{ text: "staging runs on port 4000", date: "2026-10-03" }],
};

test("a reply with a missing kind list, or {}, is a bad reply: file unchanged, items unpromoted", async () => {
  const s = setup(OWNER);
  s.episodes(5);
  const raw = (o: object) => async () => ({ text: JSON.stringify(o), usage: emptyUsage() });
  expect(await s.run(raw({ decisions: [], preferences: [], lessons: [] }))).toBe("bad_reply");
  s.advance(DREAM_DEBOUNCE_MS + 1);
  expect(await s.run(raw({}))).toBe("bad_reply");
  expect(s.file()).toBe(OWNER);
  expect(getThreadSummary(s.db, "e0")?.promoted_at).toBe(0);
});

test("an all-empty result is refused when the file has dated bullets", async () => {
  const s = setup(OWNER);
  s.episodes(5);
  expect(await s.run(async () => json({}))).toBe("shrink_guard");
  expect(s.file()).toBe(OWNER);
  expect(getThreadSummary(s.db, "e0")?.promoted_at).toBe(0);
});

test("4 near-duplicates and an empty result are refused", async () => {
  const dups = ["alpha", "bravo", "charlie", "delta"].map(
    (w, i) => `- deploy runs every friday evening staging cluster ${w} (2026-10-0${i + 1})`,
  );
  const mem = `# t\n\n## Facts\n${dups.join("\n")}\n`;
  const s = setup(mem);
  s.episodes(5);
  expect(await s.run(async () => json({}))).toBe("shrink_guard");
  expect(s.file()).toBe(mem);
});

test("indented owner sub-bullets and bullets under ### stay byte-identical", async () => {
  const mem = [
    "## Facts",
    "- staging runs on port 4000 (2026-10-03)",
    "  - sub (2026-01-01)",
    "### Owner sub heading",
    "- under h3 (2026-01-02)",
    "",
  ].join("\n");
  const s = setup(mem);
  s.episodes(5);
  const res = await s.run(async () =>
    json({
      facts: [
        { text: "staging runs on port 4000", date: "2026-10-03" },
        { text: "new durable fact" },
      ],
    }),
  );
  expect(res).toBe("dreamed");
  const f = s.file();
  expect(f).toContain("\n  - sub (2026-01-01)\n");
  expect(f).toContain("### Owner sub heading\n- under h3 (2026-01-02)\n");
  expect(s.calls[0]).not.toContain("sub (2026-01-01)");
});

test("a bullet the owner deleted during the model call is not re-added", async () => {
  const s = setup(OWNER);
  s.episodes(5);
  const res = await s.run(async () => {
    writeFileSync(s.ch.memory, OWNER.replace("- staging runs on port 4000 (2026-10-03)\n", ""));
    return json(KEEP_OWNER);
  });
  expect(res).toBe("dreamed");
  expect(s.file()).not.toContain("port 4000");
});

test("a bullet the owner edited during the model call appears once; an unreconcilable edit skips the dream", async () => {
  const edit = () =>
    writeFileSync(s.ch.memory, OWNER.replace("port 4000 (2026-10-03)", "port 5000 (2026-10-03)"));
  const s = setup(OWNER);
  s.episodes(5);
  expect(
    await s.run(async () => {
      edit();
      return json(KEEP_OWNER);
    }),
  ).toBe("dreamed");
  expect(datedBullets(s.file(), "fact")).toEqual(["- staging runs on port 5000 (2026-10-03)"]);

  // The model dropped the bullet the owner edited meanwhile: no way to tell, nothing is written.
  const s2 = setup(OWNER);
  s2.episodes(5);
  expect(
    await s2.run(async () => {
      writeFileSync(
        s2.ch.memory,
        OWNER.replace("port 4000 (2026-10-03)", "port 5000 (2026-10-03)"),
      );
      return json({ decisions: [{ text: "use postgres", date: "2026-10-01" }] });
    }),
  ).toBe("file_changed");
  expect(s2.file()).toContain("port 5000");
  expect(s2.backups()).toEqual([]);
  expect(getThreadSummary(s2.db, "e0")?.promoted_at).toBe(0);
});

test("notes over DREAM_NOTES_MAX_CHARS: the newest are sent, the rest stay untouched in the file", async () => {
  const bullets = Array.from(
    { length: 600 },
    (_, i) =>
      `- note${i}alpha detail${i}bravo padding padding padding padding padding padding (2026-${i < 300 ? "01" : "06"}-01)`,
  );
  const mem = `# t\n\n## Facts\n${bullets.join("\n")}\n`;
  const p = buildPrompt(mem, []);
  expect(p.total).toBe(600);
  expect(p.sent.length).toBeLessThan(600);
  expect(p.prompt).toContain("note599alpha");
  expect(p.prompt).not.toContain("note0alpha");
  const s = setup(mem);
  s.episodes(5);
  const echo = p.sent.map((b) => ({ text: b.slice(2, -13), date: b.slice(-11, -1) }));
  expect(await s.run(async () => json({ facts: echo }))).toBe("dreamed");
  expect(datedBullets(s.file(), "fact")).toHaveLength(600);
});

test("secrets in an episode never reach the model input", async () => {
  const s = setup(OWNER);
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 5; i++)
    saveSummary(s.db, {
      threadId: `x${i}`,
      workspace: WS,
      channel: CH,
      summary: `the deploy key is ${secret}`,
      source: "idle",
      now: T0 - 60_000,
    });
  await s.run(async () => json(KEEP_OWNER));
  expect(s.calls[0]).not.toContain(secret);
});

test("a failed backup is backup_failed, not llm_failed; the file stays", async () => {
  const s = setup(OWNER);
  s.episodes(5);
  const dir = workspacePaths(s.home).memoryBackups(WS, CH);
  mkdirSync(join(dir, ".."), { recursive: true });
  writeFileSync(dir, "not a dir");
  const res = await s.run(async () =>
    json({ ...KEEP_OWNER, lessons: [{ text: "a new lesson", date: "2026-10-21" }] }),
  );
  expect(res).toBe("backup_failed");
  expect(s.file()).toBe(OWNER);
  expect(getThreadSummary(s.db, "e0")?.promoted_at).toBe(0);
});

test("a file that is not valid UTF-8 is never rewritten", async () => {
  const s = setup();
  const bytes = Buffer.concat([
    Buffer.from("## Facts\n- bad "),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(" (2026-01-01)\n"),
  ]);
  writeFileSync(s.ch.memory, bytes);
  s.episodes(5);
  expect(await s.run(async () => json({ facts: [{ text: "new fact" }] }))).toBe("not_utf8");
  expect(readFileSync(s.ch.memory).equals(bytes)).toBe(true);
  expect(s.backups()).toEqual([]);
  expect(getThreadSummary(s.db, "e0")?.promoted_at).toBe(0);
});
