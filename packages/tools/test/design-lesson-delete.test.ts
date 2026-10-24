import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBotDesignTool } from "../src/design/tools/BotDesignTool/bot-design-tool";
import { FileMemory } from "../src/memory/file-memory";
import { call, setup, textOf } from "./design-fixture";

/** A context with a real file memory, the bot `ann` in the owner's config and optionally a group holding it. */
function withAnn(groupMembers: string[] = []) {
  const s = setup();
  const memory = new FileMemory(join(s.home, "memory"));
  writeFileSync(join(s.configDir, "bots", "ann.md"), "---\nname: Ann\n---\nWork.\n");
  s.ctx.memory = memory;
  s.ctx.botSummaries = () => [
    { id: "friday", name: "Friday", title: "t" },
    { id: "ann", name: "Ann", title: "dev" },
  ];
  s.ctx.groupSummaries = () =>
    groupMembers.length ? [{ id: "team", name: "Team", members: groupMembers }] : [];
  return { ...s, memory, tool: createBotDesignTool(s.ctx) };
}

test("add_lesson writes one line under Lessons of the bot's MEMORY.md", async () => {
  const { tool, memory } = withAnn();
  const r = await call(tool, {
    action: "add_lesson",
    id: "ann",
    lesson: "Run the tests before you say done.",
  });
  expect(r.isError).toBeUndefined();
  const text = await memory.read({ kind: "bot", botId: "ann" });
  expect(text).toContain("## Lessons");
  expect(text).toContain("Run the tests before you say done.");
});

test("add_lesson refuses friday, an unknown bot, empty, multi-line and too long text", async () => {
  const { tool } = withAnn();
  const bads = [
    { id: "friday", lesson: "x y z" },
    { id: "ghost", lesson: "x y z" },
    { id: "ann", lesson: "   " },
    { id: "ann", lesson: "line one\nline two" },
    { id: "ann", lesson: "x".repeat(301) },
  ];
  for (const b of bads) {
    const r = await call(tool, { action: "add_lesson", ...b });
    expect(r.isError).toBe(true);
  }
});

test("delete_bot moves the bot file and its memory to the trash", async () => {
  const { tool, configDir, home, memory } = withAnn();
  await memory.save({ kind: "bot", botId: "ann" }, "A fact.");
  const r = await call(tool, { action: "delete_bot", id: "ann" });
  expect(r.isError).toBeUndefined();
  expect(existsSync(join(configDir, "bots", "ann.md"))).toBe(false);
  expect(existsSync(memory.dirOf({ kind: "bot", botId: "ann" }))).toBe(false);
  expect(textOf(r)).toContain("trash");
  const trash = join(home, "trash", "friday");
  const [move] = readdirSync(trash);
  const manifest = JSON.parse(readFileSync(join(trash, move ?? "", "manifest.json"), "utf8"));
  expect(manifest.entries).toHaveLength(2);
});

test("delete_bot refuses friday, a shipped-only or unknown bot, and a bot still in a group", async () => {
  const { tool, configDir } = withAnn(["ann", "bob"]);
  for (const id of ["friday", "ghost"]) {
    const r = await call(tool, { action: "delete_bot", id });
    expect(r.isError).toBe(true);
  }
  const inGroup = await call(tool, { action: "delete_bot", id: "ann" });
  expect(textOf(inGroup)).toContain("team");
  expect(existsSync(join(configDir, "bots", "ann.md"))).toBe(true);
});

test("delete_bot without a memory dir moves only the bot file", async () => {
  const { tool, configDir } = withAnn();
  const r = await call(tool, { action: "delete_bot", id: "ann" });
  expect(r.isError).toBeUndefined();
  expect(existsSync(join(configDir, "bots", "ann.md"))).toBe(false);
});
