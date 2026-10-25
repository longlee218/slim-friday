import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBotFile } from "@friday/config";
import type { ChatContext } from "../../src/chat/chat-context";
import { createUpdateProfileTool } from "../../src/chat/tools/UpdateProfileTool/update-profile-tool";
import { call, textOf } from "../design-fixture";

const FILE = (name: string) =>
  `---\nname: ${name}\ntitle: old\nmodel: m\ntools: []\n---\nBe brief.\n`;

/** A config dir with bots `ann` and `bob`; the tool acts for `ann`. */
function make() {
  const configDir = mkdtempSync(join(tmpdir(), "profile-"));
  mkdirSync(join(configDir, "bots"));
  for (const n of ["ann", "bob"]) writeFileSync(join(configDir, "bots", `${n}.md`), FILE(n));
  const read = (id: string) => readFileSync(join(configDir, "bots", `${id}.md`), "utf8");
  const ctx = {
    botId: "ann",
    profile: {
      configDir,
      readBotFile: (id: string) => read(id),
      checkBot: (id: string, t: string) => void parseBotFile(id, t),
    },
  } as unknown as ChatContext;
  return { tool: createUpdateProfileTool(ctx), read };
}

test("UpdateProfile sets title and description of the calling bot only", async () => {
  const { tool, read } = make();
  const r = await call(tool, { title: "Reviewer", description: "Reviews pull requests." });
  expect(r.isError).toBeUndefined();
  const bot = parseBotFile("ann", read("ann"));
  expect(bot.title).toBe("Reviewer");
  expect(bot.description).toBe("Reviews pull requests.");
  expect(bot.instructions).toBe("Be brief.");
  expect(read("bob")).toBe(FILE("bob"));
});

test("a bot id in the input is ignored: another bot's file is never written", async () => {
  const { tool, read } = make();
  await call(tool, { id: "bob", botId: "bob", title: "Hacked" });
  expect(read("bob")).toBe(FILE("bob"));
  expect(parseBotFile("ann", read("ann")).title).toBe("Hacked");
});

test("invalid fields are refused with a readable error and nothing changes", async () => {
  const { tool, read } = make();
  const before = read("ann");
  const tooLong = await call(tool, { description: "x".repeat(501) });
  expect(tooLong.isError).toBe(true);
  expect(textOf(tooLong)).toContain("description");
  const blank = await call(tool, { title: "  " });
  expect(blank.isError).toBe(true);
  expect((await call(tool, {})).isError).toBe(true);
  expect(read("ann")).toBe(before);
});

test("a shipped bot (no file of its own) is refused", async () => {
  const { tool } = make();
  const ctx = {
    botId: "ghost",
    profile: { configDir: "/nonexistent", readBotFile: () => FILE("ghost"), checkBot: () => {} },
  };
  const r = await call(createUpdateProfileTool(ctx as unknown as ChatContext), { title: "x" });
  expect(r.isError).toBe(true);
  void tool;
});
