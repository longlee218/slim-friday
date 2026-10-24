import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Group } from "@friday/core";
import { FileMemory } from "../src/memory/file-memory";
import type { ToolSessionContext } from "../src/memory/memory-owner";
import { createMemoryEditTool } from "../src/memory/tools/MemoryEditTool/memory-edit-tool";
import { createMemorySaveTool } from "../src/memory/tools/MemorySaveTool/memory-save-tool";
import { MEMORY_SAVE_DESCRIPTION } from "../src/memory/tools/MemorySaveTool/prompt";

const team: Group = {
  id: "team",
  name: "Team",
  members: ["ann", "bob"],
  entryBot: "ann",
  workspaces: [],
  instructions: "",
};
const other: Group = {
  id: "other",
  name: "Other",
  members: ["bob"],
  entryBot: "bob",
  workspaces: [],
  instructions: "",
};
const convs: Record<string, Conversation> = {
  dm: { id: "dm", kind: "direct", botId: "ann" },
  g1: { id: "g1", kind: "group", groupId: "team" },
  g2: { id: "g2", kind: "group", groupId: "other" },
};

/** Ann's tool context while she answers in conversation `cid`. */
const ctx = (cid: string): ToolSessionContext => ({
  botId: "ann",
  conversation: async () => convs[cid],
  group: async (id) => [team, other].find((g) => g.id === id),
});
type Result = { content: { text: string }[]; isError?: boolean };
const text = (r: Result) => r.content[0]?.text ?? "";
/** Call a tool's handler the way the SDK does (args are already validated there). */
const call = (t: { handler: (a: never, e: unknown) => Promise<unknown> }, args: object) =>
  t.handler(args as never, {}) as Promise<Result>;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "memt-"));
  return { root, mem: new FileMemory(root) };
}
const file = (root: string, rel: string) => {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return "";
  }
};

test("MemorySave: bot scope writes the bot's file", async () => {
  const { root, mem } = setup();
  const r = await call(createMemorySaveTool(mem, ctx("dm")), { note: "likes tea" });
  expect(text(r)).toBe("saved");
  expect(file(root, "bots/ann/MEMORY.md")).toContain("likes tea");
});

test("MemorySave: group scope only from a group conversation the bot is a member of", async () => {
  const { root, mem } = setup();
  const fromDm = await call(createMemorySaveTool(mem, ctx("dm")), { note: "x1", scope: "group" });
  expect(fromDm.isError).toBe(true);
  expect(text(fromDm)).toContain("group conversation");
  const notMember = await call(createMemorySaveTool(mem, ctx("g2")), {
    note: "x2",
    scope: "group",
  });
  expect(notMember.isError).toBe(true);
  expect(file(root, "groups/other/MEMORY.md")).toBe("");
  await call(createMemorySaveTool(mem, ctx("g1")), { note: "team uses bun", scope: "group" });
  expect(file(root, "groups/team/MEMORY.md")).toContain("team uses bun");
});

test("MemorySave: a duplicate is reported, not saved twice", async () => {
  const { mem } = setup();
  const save = createMemorySaveTool(mem, ctx("dm"));
  await call(save, { note: "likes tea" });
  const r = await call(save, { note: "Likes tea." });
  expect(r.isError).toBe(true);
  expect(text(r)).toBe("duplicate");
});

test("MemorySave and MemoryEdit: an over-long note is refused with the limit, nothing stored", async () => {
  const { root, mem } = setup();
  const save = createMemorySaveTool(mem, ctx("dm"));
  const r = await call(save, { note: "x".repeat(250) });
  expect(r.isError).toBe(true);
  expect(text(r)).toStartWith("too_long");
  expect(text(r)).toContain("200");
  expect(file(root, "bots/ann/MEMORY.md")).toBe("");
  await call(save, { note: "short fact" });
  const edit = createMemoryEditTool(mem, ctx("dm"));
  const id = /\[([0-9a-f]{16})\]/.exec(text(await call(edit, {})))?.[1] ?? "";
  const e = await call(edit, { id, text: "y".repeat(250) });
  expect(e.isError).toBe(true);
  expect(text(e)).toStartWith("too_long");
  expect(file(root, "bots/ann/MEMORY.md")).toContain("short fact");
});

test("MemoryEdit: lists ids, deletes one, unknown id is not_found", async () => {
  const { root, mem } = setup();
  await call(createMemorySaveTool(mem, ctx("dm")), { note: "old fact" });
  const edit = createMemoryEditTool(mem, ctx("dm"));
  const list = text(await call(edit, {}));
  const id = /\[([0-9a-f]{16})\]/.exec(list)?.[1] ?? "";
  expect(list).toContain("old fact");
  expect(text(await call(edit, { id, delete: true }))).toBe("deleted");
  expect(file(root, "bots/ann/MEMORY.md")).not.toContain("old fact");
  expect(text(await call(edit, { id: "0000000000000000", text: "x" }))).toBe("not_found");
});

test("no tool-name literal outside a constants.ts", () => {
  const src = join(import.meta.dir, "..", "src");
  const names = [
    "MemorySave",
    "MemoryEdit",
    "MemorySearch",
    "DeletePaths",
    "GitPush",
    "CreatePullRequest",
    "MergeBranch",
    "CreateProject",
  ];
  const bad: string[] = [];
  for (const rel of new Bun.Glob("**/*.ts").scanSync(src)) {
    if (rel.endsWith("constants.ts")) continue;
    const body = readFileSync(join(src, rel), "utf8");
    for (const n of names) if (body.includes(`"${n}"`)) bad.push(`${rel}: ${n}`);
  }
  expect(bad).toEqual([]);
});

test("MemoryEdit in a group session lists and edits only preference and lesson notes", async () => {
  const { mem } = setup();
  await mem.save({ kind: "bot", botId: "ann" }, "owner wants short answers", "preference");
  await mem.save({ kind: "bot", botId: "ann" }, "owner's bank is in Hanoi");
  const groupCtx: ToolSessionContext = { ...ctx("g1"), groupId: "team" };
  const edit = createMemoryEditTool(mem, groupCtx);
  const list = text(await call(edit, {}));
  expect(list).toContain("short answers");
  expect(list).not.toContain("bank");
  const factId = mem.listBullets({ kind: "bot", botId: "ann" }).find((b) => b.kind === "fact")?.id;
  expect(text(await call(edit, { id: factId, delete: true }))).toBe("not_found");
});

test("MemorySave tells which scope fits which note", () => {
  expect(MEMORY_SAVE_DESCRIPTION).toContain(
    "knowledge about the group's project or way of working goes to group; facts about the owner go to bot",
  );
});

test("MemorySave in a group session does not reveal a hidden note through duplicate", async () => {
  const { mem } = setup();
  await mem.save({ kind: "bot", botId: "ann" }, "owner's bank is in Hanoi");
  await mem.save({ kind: "bot", botId: "ann" }, "owner wants short answers", "preference");
  const save = createMemorySaveTool(mem, { ...ctx("g1"), groupId: "team" });
  expect(text(await call(save, { note: "owner's bank is in Hanoi" }))).toBe("saved");
  expect(text(await call(save, { note: "owner wants short answers", kind: "preference" }))).toBe(
    "duplicate",
  );
});
