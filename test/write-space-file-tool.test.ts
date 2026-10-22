import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createWriteSpaceFileTool } from "../src/mcp/discord-admin/tools/WriteSpaceFileTool/write-space-file-tool";
import { searchIndex } from "../src/memory/index/memory-search";
import { ensureChannelDir } from "../src/memory/persona";
import type {
  ConfirmQuestion,
  DiscordAdminContext,
} from "../src/providers/discord/setup/discord-admin-context";
import {
  addWorkspaceChannel,
  createWorkspaceDir,
} from "../src/providers/discord/setup/workspace-template";
import { writeSpaceFile } from "../src/providers/discord/setup/write-space-file";
import { openDb } from "../src/storage/db";
import { assertTempHome, outsideDir } from "./helpers";

/** A home with space `study` and its channel `study-agent`; `answer` is what the owner clicks. */
function setup(answer = true) {
  const home = mkdtempSync(join(tmpdir(), "friday-wsf-"));
  assertTempHome(home);
  createWorkspaceDir(home, "study");
  addWorkspaceChannel(home, "study", {
    id: "100000000000000009",
    name: "study-agent",
    mode: "task",
  });
  ensureChannelDir(home, "study", "study-agent");
  const asked: ConfirmQuestion[] = [];
  const ctx: DiscordAdminContext = {
    home,
    init: {} as never,
    confirm: async (q) => {
      asked.push(q);
      return answer;
    },
    now: () => new Date("2026-10-15T10:00:00.123Z"),
  };
  const ws = workspacePaths(home).workspace("study");
  const memory = ws.channel("study-agent").memory;
  return { home, ctx, asked, ws, memory, backups: join(home, "backups", "persona") };
}

const NEW = "# Soul\n- Patient and clear.\n- Short steps.\n";

test("yes: the file is replaced (0600), the old one is backed up, the owner saw the diff first", async () => {
  const s = setup();
  const before = readFileSync(s.ws.soul, "utf8");
  const r = await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: NEW });
  expect(r.error).toBe(false);
  expect(r.text).toContain("written study/SOUL.md");
  expect(readFileSync(s.ws.soul, "utf8")).toBe(NEW);
  expect(statSync(s.ws.soul).mode & 0o777).toBe(0o600);
  const [backup] = readdirSync(join(s.backups, "study"));
  expect(backup).toBe("SOUL.md-20261015-100000123Z");
  expect(readFileSync(join(s.backups, "study", backup!), "utf8")).toBe(before);
  expect(s.asked).toHaveLength(1);
  expect(s.asked[0]?.detail).toContain("+- Patient and clear.");
  expect(s.asked[0]?.detail).toContain("--- a/study/SOUL.md");
  expect(readdirSync(s.ws.root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("a channel file goes to channels/<name>/ with its own backup name", async () => {
  const s = setup();
  const r = await writeSpaceFile(s.ctx, {
    space: "study",
    channel: "study-agent",
    file: "USER.md",
    content: "# User\n- Vietnamese.\n",
  });
  expect(r.error).toBe(false);
  expect(readFileSync(s.ws.channel("study-agent").user, "utf8")).toBe("# User\n- Vietnamese.\n");
  expect(existsSync(s.ws.user)).toBe(true); // the space's own file is untouched
  expect(readFileSync(s.ws.user, "utf8")).toContain("Optional override");
  expect(existsSync(s.backups)).toBe(false); // the channel file did not exist: nothing to back up
});

test("owner says no (or does not answer): nothing is written, no backup", async () => {
  const s = setup(false);
  const before = readFileSync(s.ws.soul, "utf8");
  const r = await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: NEW });
  expect(r.text).toContain("not written");
  expect(readFileSync(s.ws.soul, "utf8")).toBe(before);
  expect(existsSync(s.backups)).toBe(false);
});

test("a confirm that throws is never a write (the tool wrapper turns it into an error)", async () => {
  const s = setup();
  s.ctx.confirm = async () => {
    throw new Error("gateway down");
  };
  const tool = createWriteSpaceFileTool(s.ctx);
  const before = readFileSync(s.ws.soul, "utf8");
  const r = await tool.handler({ space: "study", file: "SOUL.md", content: NEW } as never, {});
  expect(r.isError).toBe(true);
  expect(readFileSync(s.ws.soul, "utf8")).toBe(before);
});

test("bad names are refused before the owner is asked", async () => {
  const s = setup();
  const w = (a: Record<string, string | undefined>) =>
    writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: NEW, ...a } as never);
  for (const file of ["../SOUL.md", "soul.md", "notes.txt", "AGENTS.md/../x", "workspace.yaml", ""])
    expect((await w({ file })).error).toBe(true);
  for (const space of ["../x", "study/../x", "Study", "nope", ""])
    expect((await w({ space })).error).toBe(true);
  for (const channel of ["../x", "study-agent/..", "ghost", ""])
    expect((await w({ channel })).error).toBe(true);
  expect(s.asked).toHaveLength(0);
});

test("a symlinked channel folder pointing outside the space is refused", async () => {
  const s = setup();
  const out = outsideDir();
  const dir = s.ws.channel("study-agent").root;
  mkdirSync(join(s.ws.root, "channels"), { recursive: true });
  // replace the real channel dir by a symlink to an outside dir
  await Bun.$`rm -rf ${dir}`.quiet();
  symlinkSync(out, dir);
  const r = await writeSpaceFile(s.ctx, {
    space: "study",
    channel: "study-agent",
    file: "SOUL.md",
    content: NEW,
  });
  expect(r.error).toBe(true);
  expect(readdirSync(out)).toEqual([]);
  expect(s.asked).toHaveLength(0);
});

test("a symlinked target file is refused (even when it points inside the space)", async () => {
  const s = setup();
  const out = outsideDir();
  const victim = join(out, "victim.md");
  writeFileSync(victim, "keep");
  await Bun.$`rm -f ${s.ws.soul}`.quiet();
  symlinkSync(victim, s.ws.soul);
  expect(
    (await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: NEW })).error,
  ).toBe(true);
  expect(readFileSync(victim, "utf8")).toBe("keep");
  await Bun.$`rm -f ${s.ws.soul}`.quiet();
  symlinkSync(s.ws.user, s.ws.soul); // an in-space link is no better: a link is never written through
  expect(
    (await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: NEW })).error,
  ).toBe(true);
  expect(s.asked).toHaveLength(0);
});

test("a symlinked space folder is not a space", async () => {
  const s = setup();
  const out = outsideDir();
  mkdirSync(join(out, "workspaces-copy"));
  const link = workspacePaths(s.home).workspace("linked").root;
  symlinkSync(out, link);
  const r = await writeSpaceFile(s.ctx, { space: "linked", file: "SOUL.md", content: NEW });
  expect(r.error).toBe(true);
  expect(readdirSync(out)).toEqual(["workspaces-copy"]);
});

test("the diff shown to the owner is redacted; content with a secret is refused", async () => {
  const s = setup();
  const secret = "sk-ant-api03-abcdefghijklmnop1234";
  writeFileSync(s.ws.soul, `# Soul\nkey sk-ant-oat-abcdefghijklmnop5678 was pasted here\n- tone\n`);
  const r = await writeSpaceFile(s.ctx, {
    space: "study",
    file: "SOUL.md",
    content: "# Soul\n- tone\n",
  });
  expect(r.error).toBe(false);
  expect(s.asked[0]?.detail).not.toContain("abcdefghijklmnop5678");
  expect(s.asked[0]?.detail).toContain("[REDACTED]");
  const bad = await writeSpaceFile(s.ctx, {
    space: "study",
    file: "SOUL.md",
    content: `# Soul\ntoken ${secret}\n`,
  });
  expect(bad.error).toBe(true);
  expect(s.asked).toHaveLength(1); // the secret was refused before any question
});

test("too long content, NUL bytes, no change", async () => {
  const s = setup();
  expect(
    (await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: "x".repeat(6001) }))
      .error,
  ).toBe(true);
  expect(
    (await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: "a\0b" })).error,
  ).toBe(true);
  const same = readFileSync(s.ws.soul, "utf8");
  const r = await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: same });
  expect(r).toEqual({ text: "no change: the file already has this content", error: false });
  expect(s.asked).toHaveLength(0);
});

test("a channel MEMORY.md is a writable file too (and is created when missing)", async () => {
  const s = setup();
  await Bun.$`rm -f ${s.memory}`.quiet();
  const r = await writeSpaceFile(s.ctx, {
    space: "study",
    channel: "study-agent",
    file: "MEMORY.md",
    content: "# Memory\n## Facts\n- a\n",
  });
  expect(r.error).toBe(false);
  expect(readFileSync(s.memory, "utf8")).toContain("- a");
});

test("content over 6000 chars: a channel MEMORY.md is accepted, a persona file is refused", async () => {
  const s = setup();
  const big = `# Memory\n${"- fact\n".repeat(1200)}`;
  expect(big.length).toBeGreaterThan(6000);
  const m = await writeSpaceFile(s.ctx, {
    space: "study",
    channel: "study-agent",
    file: "MEMORY.md",
    content: big,
  });
  expect(m.error).toBe(false);
  expect(readFileSync(s.memory, "utf8")).toBe(big);
  const p = await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: big });
  expect(p).toEqual({ text: "content must be text of at most 6000 chars", error: true });
});

test("a space-level MEMORY.md is refused: memory belongs to a channel", async () => {
  const s = setup();
  const r = await writeSpaceFile(s.ctx, {
    space: "study",
    file: "MEMORY.md",
    content: "# Memory\n- x\n",
  });
  expect(r).toEqual({ text: "MEMORY.md belongs to a channel", error: true });
  expect(s.asked).toHaveLength(0);
});

test("the file changed while the owner decided: nothing is written, the other writer's bytes stay", async () => {
  const s = setup();
  const other = "# Soul\n- Edited by someone else meanwhile.\n";
  s.ctx.confirm = async () => {
    writeFileSync(s.ws.soul, other); // another writer wins during the owner's decision
    return true;
  };
  const r = await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: NEW });
  expect(r.error).toBe(true);
  expect(r.text).toContain("changed since the diff");
  expect(readFileSync(s.ws.soul, "utf8")).toBe(other);
  expect(existsSync(s.backups)).toBe(false);
});

test("backups: one folder per target, only the newest 10 are kept", async () => {
  const s = setup();
  let ms = 0;
  s.ctx.now = () => new Date(Date.UTC(2026, 9, 15, 10, 0, 0, ms++));
  for (let n = 0; n < 12; n++)
    await writeSpaceFile(s.ctx, { space: "study", file: "SOUL.md", content: `# Soul\n- v${n}\n` });
  // a channel target never shares (or prunes) the space's folder
  await writeSpaceFile(s.ctx, {
    space: "study",
    channel: "study-agent",
    file: "MEMORY.md",
    content: "# Memory\n- c\n",
  });
  await writeSpaceFile(s.ctx, {
    space: "study",
    channel: "study-agent",
    file: "MEMORY.md",
    content: "# Memory\n- d\n",
  });
  const kept = readdirSync(join(s.backups, "study")).filter((f) => f.startsWith("SOUL.md-"));
  expect(kept).toHaveLength(10);
  // the oldest two (the template, v0) are gone; the newest backup holds v10
  expect(kept.sort().at(-1)).toBe("SOUL.md-20261015-100000011Z");
  expect(readFileSync(join(s.backups, "study", kept.sort().at(-1)!), "utf8")).toContain("- v10");
  expect(readdirSync(join(s.backups, "study", "channels", "study-agent"))).toHaveLength(2);
});

test("a written MEMORY.md is searchable at once (re-indexed)", async () => {
  const s = setup();
  const db = openDb(":memory:");
  s.ctx.db = db;
  const r = await writeSpaceFile(s.ctx, {
    space: "study",
    channel: "study-agent",
    file: "MEMORY.md",
    content: "# Memory\n## Facts\n- zebracorn vocabulary list\n",
  });
  expect(r.error).toBe(false);
  const { hits } = searchIndex(db, "study", {
    query: "zebracorn",
    limit: 5,
    channel: "study-agent",
  });
  expect(hits.length).toBeGreaterThan(0);
});

test("the memory lock is held by another writer: nothing is written (after the 5 s lock wait)", async () => {
  const s = setup();
  const before = readFileSync(s.memory, "utf8");
  writeFileSync(`${s.memory}.lock`, String(process.pid)); // a live holder (this process)
  const r = await writeSpaceFile(s.ctx, {
    space: "study",
    channel: "study-agent",
    file: "MEMORY.md",
    content: "# Memory\n- x\n",
  });
  expect(r.error).toBe(true);
  expect(r.text).toContain("busy");
  expect(readFileSync(s.memory, "utf8")).toBe(before);
}, 10_000);
