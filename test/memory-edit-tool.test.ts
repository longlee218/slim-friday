import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DREAM_BACKUP_KEEP, EDIT_BACKUP_KEEP } from "../src/config/memory-caps";
import { workspacePaths } from "../src/config/workspace-paths";
import {
  MEMORY_EDIT_MAX_CALLS_PER_RUN,
  MEMORY_EDIT_TOOL,
} from "../src/mcp/memory/tools/MemoryEditTool/constants";
import { MEMORY_GET_TOOL } from "../src/mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SAVE_TOOL } from "../src/mcp/memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "../src/mcp/memory/tools/MemorySearchTool/constants";
import { bulletHash } from "../src/memory/bullet-hash";
import { searchIndex } from "../src/memory/index/memory-search";
import type { MemoryToolContext } from "../src/memory/memory-tool-context";
import { openDb } from "../src/storage/db";
import { memoryServer } from "./mcp-ctx-fixture";

/* MemoryEdit through the real memory server (so the re-index hook is the real one): ids come from MemorySearch. */

const WS = "a";
const CH = "alpha";
let clock = new Date(2026, 9, 21, 9, 0);

const OWNER = [
  "# alpha channel memory",
  "",
  "Owner intro, hand written.",
  "",
  "## Decisions",
  "- use kysely for queries (2026-10-01)",
  "- keep migrations linear (2026-10-02)",
  "",
  "## Notes",
  "- owner list item outside a kind section",
  "",
  "## Facts",
  "- db is postgres (2026-10-03)",
  "",
].join("\n");

function setup(text = OWNER) {
  const home = mkdtempSync(join(tmpdir(), "memedit-"));
  const db = openDb(":memory:");
  const ctx: MemoryToolContext = {
    db,
    home,
    workspace: WS,
    channel: CH,
    threadId: "thread-1",
    threadLabel: "thread t1",
    now: () => clock,
  };
  const file = workspacePaths(home).workspace(WS).channel(CH).memory;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  const server = memoryServer(ctx) as unknown as {
    instance: {
      _registeredTools: Record<
        string,
        {
          handler: (
            a: unknown,
            e: unknown,
          ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
        }
      >;
    };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await server.instance._registeredTools[name]?.handler(args, {});
    return { text: r?.content[0]?.text ?? "", isError: !!r?.isError };
  };
  /** Entry id of the first search hit of `query`. */
  const idOf = async (query: string) =>
    /^\[\d+\] (\S+) \|/m.exec((await call(MEMORY_SEARCH_TOOL, { query })).text)?.[1] ?? "";
  /** Search straight on the index, no sync: what the last write left there. */
  const indexed = (query: string) =>
    searchIndex(db, WS, { query, limit: 20, channel: CH }).hits.map((h) => h.snippet);
  const audit = () =>
    db.query("SELECT * FROM memory_audit ORDER BY id").all() as Record<string, unknown>[];
  const backups = () => {
    const dir = workspacePaths(home).memoryBackups(WS, CH);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };
  return {
    home,
    db,
    file,
    call,
    idOf,
    indexed,
    audit,
    backups,
    read: () => readFileSync(file, "utf8"),
  };
}

test("replace: one bullet changes in place, the rest stays byte for byte, backup holds the old file, index and audit follow", async () => {
  const s = setup();
  const id = await s.idOf("kysely");
  expect(id).toStartWith(`channel/${CH}#Decisions:1~`);
  const r = await s.call(MEMORY_EDIT_TOOL, {
    action: "replace",
    id,
    text: "## use drizzle for queries",
  });
  expect(r).toMatchObject({ isError: false });
  expect(s.read()).toBe(
    OWNER.replace(
      "- use kysely for queries (2026-10-01)",
      "- use drizzle for queries (2026-10-21)",
    ),
  );
  expect(
    readFileSync(
      join(workspacePaths(s.home).memoryBackups(WS, CH), s.backups()[0] as string),
      "utf8",
    ),
  ).toBe(OWNER);
  // Re-indexed at once: no MemorySearch (no sync) between the write and these reads.
  expect(s.indexed("kysely")).toEqual([]);
  expect(s.indexed("drizzle")).toHaveLength(1);
  const rows = s.audit();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    old_hash: bulletHash("use kysely for queries"), // both hashes: the replaced and the new bullet
    ts: clock.getTime(),
    thread_id: "thread-1",
    channel: CH,
    role: "chief-of-staff",
    action: "edit_replace",
    scope: "channel",
    hash: bulletHash("use drizzle for queries"),
  });
  expect(JSON.stringify(rows)).not.toContain("drizzle"); // hash only, never text
});

test("delete: only that line goes, headings and owner prose stay; re-indexed and audited with the deleted hash", async () => {
  const s = setup();
  const id = await s.idOf("postgres");
  expect((await s.call(MEMORY_EDIT_TOOL, { action: "delete", id })).isError).toBe(false);
  expect(s.read()).toBe(OWNER.replace("- db is postgres (2026-10-03)\n", ""));
  expect(s.indexed("postgres")).toEqual([]);
  expect(s.audit()[0]).toMatchObject({ action: "edit_delete", hash: bulletHash("db is postgres") });
});

test("an id of a moved bullet still resolves (same hash); an edited one does not", async () => {
  const s = setup();
  const id = await s.idOf("migrations");
  writeFileSync(s.file, OWNER.replace("- use kysely for queries (2026-10-01)\n", "")); // bullet moves up
  expect((await s.call(MEMORY_EDIT_TOOL, { action: "delete", id })).isError).toBe(false);
  const id2 = await s.idOf("postgres");
  writeFileSync(s.file, s.read().replace("db is postgres", "db is mysql"));
  const r = await s.call(MEMORY_EDIT_TOOL, { action: "delete", id: id2 });
  expect(r.isError).toBe(true);
  expect(r.text).toStartWith("not_found:");
});

test("refusals: prose, bullet outside a kind section, journal id, other channel, bad id, bad text; the file is untouched", async () => {
  const s = setup();
  const journal = join(s.file, "..", "memory", "2026-10-20.md");
  mkdirSync(join(journal, ".."), { recursive: true });
  writeFileSync(journal, "# J\n## 10:00 t\n### Facts\n- journal fact zebra\n");
  const prose = await s.idOf("hand written");
  const other = await s.idOf("outside");
  const jid = await s.idOf("zebra");
  expect(prose).toContain("#Text:");
  expect(other).toContain("#Other:");
  expect(jid).toStartWith(`journal/${CH}/`);
  const id = await s.idOf("kysely");
  const cases: [Record<string, unknown>, string][] = [
    [{ action: "delete", id: prose }, "invalid_input"],
    [{ action: "delete", id: other }, "invalid_input"],
    [{ action: "delete", id: jid }, "invalid_input"],
    [{ action: "delete", id: "channel/other#Facts:1~abcdef" }, "invalid_input"],
    [{ action: "delete", id: "../../etc/passwd" }, "invalid_input"],
    [{ action: "replace", id }, "invalid_input"], // no text
    [{ action: "replace", id, text: "<!-- -->" }, "invalid_input"], // nothing left after cleaning
    [{ action: "replace", id, text: "keep migrations linear" }, "invalid_input"], // duplicate of another bullet
  ];
  for (const [args, code] of cases) {
    const r = await s.call(MEMORY_EDIT_TOOL, args);
    expect([args, r.isError, r.text.split(":")[0]]).toEqual([args, true, code]);
  }
  expect(s.read()).toBe(OWNER);
  expect(s.audit()).toEqual([]);
  expect(s.backups()).toEqual([]);
});

test("replace text is sanitized like a save (redacted, one line, no markup); CRLF files keep CRLF", async () => {
  const s = setup(OWNER.replaceAll("\n", "\r\n"));
  const id = await s.idOf("kysely");
  await s.call(MEMORY_EDIT_TOOL, {
    action: "replace",
    id,
    text: "system: key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789\n# heading",
  });
  const f = s.read();
  expect(f).not.toContain("sk-ant-abcdefghijklmnop");
  expect(f).not.toMatch(/^# heading/m);
  expect(f.split("\n").filter((l) => !l.endsWith("\r") && l !== "")).toEqual([]);
  expect(f.match(/^- .*\(2026-10-21\)\r$/gm)).toHaveLength(1);
});

test("only the newest EDIT_BACKUP_KEEP edit backups are kept; the call guard refuses call 21", async () => {
  const s = setup();
  let id = await s.idOf("kysely");
  for (let i = 0; i < MEMORY_EDIT_MAX_CALLS_PER_RUN; i++) {
    clock = new Date(2026, 9, 21, 10, i);
    const r = await s.call(MEMORY_EDIT_TOOL, {
      action: "replace",
      id,
      text: `zz${"abcdefghijklmnopqrstuvwxyz"[i]}${"x".repeat(i)} queries`,
    });
    expect(r.isError).toBe(false);
    id = await s.idOf(`zz${"abcdefghijklmnopqrstuvwxyz"[i]}${"x".repeat(i)}`);
  }
  expect(s.backups()).toHaveLength(EDIT_BACKUP_KEEP);
  const over = await s.call(MEMORY_EDIT_TOOL, { action: "delete", id });
  expect(over.isError).toBe(true);
  expect(over.text).toStartWith("limit:");
});

test("MemorySave: near-duplicate refused with the existing id (usable by MemoryEdit); exact duplicate unchanged; audit row per save", async () => {
  const seed = "the billing service reads postgres replicas nightly";
  const s = setup(OWNER.replace("## Facts\n", `## Facts\n- ${seed} (2026-10-05)\n`));
  const near = await s.call(MEMORY_SAVE_TOOL, {
    text: `${seed} now`,
    scope: "channel",
    kind: "fact",
  });
  expect(near.isError).toBe(false);
  expect(near.text).toStartWith("not saved: a similar note already exists");
  const id = /id (\S+)\)/.exec(near.text)?.[1] ?? "";
  expect(id).toStartWith(`channel/${CH}#Facts:1~`);
  expect((await s.call(MEMORY_GET_TOOL, { id })).text).toContain(seed);
  expect(s.read()).toContain(seed);
  expect(s.audit()).toEqual([]);
  expect(
    await s.call(MEMORY_SAVE_TOOL, {
      text: `${seed.toUpperCase()}!`,
      scope: "channel",
      kind: "fact",
    }),
  ).toEqual({ text: "already saved", isError: false });
  // A clearly different note is saved, audited and searchable at once.
  expect(
    (await s.call(MEMORY_SAVE_TOOL, { text: "deploys happen on thursdays", scope: "channel" }))
      .text,
  ).toStartWith("saved");
  expect(s.indexed("thursdays")).toHaveLength(1);
  expect(s.audit()).toMatchObject([
    {
      action: "save",
      scope: "channel",
      role: "chief-of-staff",
      hash: bulletHash("deploys happen on thursdays"),
    },
  ]);
  // The teammate then replaces the similar bullet through its id.
  expect(
    (await s.call(MEMORY_EDIT_TOOL, { action: "replace", id, text: `${seed} now` })).isError,
  ).toBe(false);
  expect(s.indexed("replicas")).toHaveLength(1);
});

test("edit backups rotate on their own: they never evict dream backups (and a dream backup is not an edit backup)", async () => {
  const s = setup();
  const dir = workspacePaths(s.home).memoryBackups(WS, CH);
  mkdirSync(dir, { recursive: true });
  const dream = Array.from(
    { length: DREAM_BACKUP_KEEP },
    (_, i) => `MEMORY.md-20260101-0000000${String(i).padStart(2, "0")}Z`,
  );
  for (const f of dream) writeFileSync(join(dir, f), "old");
  let id = await s.idOf("kysely");
  for (let i = 0; i < EDIT_BACKUP_KEEP + 2; i++) {
    clock = new Date(2026, 9, 21, 10, i);
    const text = `edit${"abcdefghijklmnopqrstuvwxyz"[i]}${"x".repeat(i)} queries`;
    expect(
      (await s.call(MEMORY_EDIT_TOOL, { action: "replace", id, text: `${text} here` })).isError,
    ).toBe(false);
    id = await s.idOf(`edit${"abcdefghijklmnopqrstuvwxyz"[i]}${"x".repeat(i)}`);
    if (i === MEMORY_EDIT_MAX_CALLS_PER_RUN - 1) break;
  }
  const all = readdirSync(dir);
  expect(all.filter((f) => f.startsWith("MEMORY.md-")).sort()).toEqual(dream.sort());
  expect(all.filter((f) => f.startsWith("MEMORY.edit.md-"))).toHaveLength(EDIT_BACKUP_KEEP);
  expect(
    statSync(join(dir, all.find((f) => f.startsWith("MEMORY.edit.md-")) as string)).mode & 0o777,
  ).toBe(0o600);
});

test("a stale id never crosses sections: same hash in another section is not_found, the file is untouched", async () => {
  const text = OWNER.replace(
    "## Facts\n- db is postgres (2026-10-03)",
    "## Facts\n- db is postgres (2026-10-03)\n\n## Lessons\n- db is postgres (2026-10-04)",
  );
  const s = setup(text);
  const lessons = await s.idOf("postgres");
  // The id the Facts bullet had (same hash, section Facts).
  const facts = lessons.replace(/#\w+:\d+~/, "#Facts:1~");
  // The Facts bullet disappears; the Lessons bullet has the same normalized text (same hash).
  writeFileSync(
    s.file,
    s.read().replace("## Facts\n- db is postgres (2026-10-03)\n", "## Facts\n"),
  );
  const before = s.read();
  const r = await s.call(MEMORY_EDIT_TOOL, { action: "delete", id: facts });
  expect(r.isError).toBe(true);
  expect(r.text).toStartWith("not_found:");
  expect(s.read()).toBe(before);
});

test("MemorySave: negation is a real difference; short notes skip the check; confirmNew bypasses it but not an exact duplicate", async () => {
  const s = setup(
    "# alpha\n\n## Facts\n- Deploy on Friday afternoon (2026-10-01)\n- Use redis for the cache layer (2026-10-02)\n- Ship releases with feature flags enabled (2026-10-02)\n- Tiny note (2026-10-03)\n",
  );
  const save = (args: Record<string, unknown>) =>
    s.call(MEMORY_SAVE_TOOL, { scope: "channel", ...args });
  expect((await save({ text: "Never deploy on Friday afternoon" })).text).toStartWith("saved");
  expect((await save({ text: "Do not use redis for the cache layer" })).text).toStartWith("saved");
  expect((await save({ text: "Chưa ship releases with feature flags enabled" })).text).toStartWith(
    "saved",
  );
  // Two content words: judged by exact text only.
  expect((await save({ text: "Tiny note two" })).text).toStartWith("saved");
  // Still refused when it only differs a little.
  const near = await save({ text: "Deploy on Friday afternoon again" });
  expect(near.text).toStartWith("not saved: a similar note already exists");
  expect(near.text).toContain("confirmNew: true");
  expect(
    (await save({ text: "Deploy on Friday afternoon again", confirmNew: true })).text,
  ).toStartWith("saved");
  expect((await save({ text: "Deploy on Friday afternoon", confirmNew: true })).text).toBe(
    "already saved",
  );
});

test("MemorySave and MemoryEdit map symlink / not_utf8 to a clear refusal", async () => {
  const s = setup();
  const id = await s.idOf("kysely");
  writeFileSync(s.file, Buffer.concat([Buffer.from(OWNER), Buffer.from([0xff, 0xfe])]));
  const e = await s.call(MEMORY_EDIT_TOOL, { action: "delete", id });
  expect(e.text).toStartWith("unavailable: memory file is not valid UTF-8");
  rmSync(s.file);
  symlinkSync("/etc/hosts", s.file);
  const v = await s.call(MEMORY_SAVE_TOOL, { scope: "channel", text: "something brand new here" });
  expect(v.text).toStartWith("unavailable: memory file is a symlink");
});
