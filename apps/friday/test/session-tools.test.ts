import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec, Store } from "@friday/core";
import { FileMemory, resolveOwner } from "@friday/tools";
import { commandEnv, sessionTools, toolContext } from "../src/session-tools";

const bot = (tools: string[]): Bot =>
  ({
    id: "ann",
    name: "Ann",
    title: "T",
    model: "m",
    instructions: "",
    tools,
    workspaces: [],
    skills: [],
    subagents: [],
  }) as Bot;
const specOf = (b: Bot, current?: string): BotRuntimeSpec => ({
  bot: b,
  decide: async () => ({ behavior: "allow" }),
  currentConversation: () => current,
});
/** A store with one group conversation `gc` of group `team` (members ann, bob). */
const store = {
  conversations: {
    get: async (id: string) =>
      id === "gc" ? { id: "gc", kind: "group", groupId: "team" } : undefined,
  },
  groups: {
    get: async (id: string) =>
      id === "team"
        ? { id: "team", name: "Team", members: ["ann", "bob"], entryBot: "ann" }
        : undefined,
  },
} as unknown as Store;

function build() {
  const root = mkdtempSync(join(tmpdir(), "st-"));
  const memory = new FileMemory(join(root, "memory"));
  const forSpec = sessionTools({
    memory,
    store,
    home: root,
    projectsDir: () => join(root, "projects"),
    isSensitive: () => false,
  });
  return { root, memory, forSpec };
}

test("every bot gets the memory server; only a bot that names an effect tool gets effects", () => {
  const { forSpec } = build();
  expect(Object.keys(forSpec(specOf(bot(["Read"]))))).toEqual(["memory"]);
  expect(Object.keys(forSpec(specOf(bot(["mcp__effects__GitPush"]))))).toEqual([
    "memory",
    "effects",
  ]);
  expect(Object.keys(forSpec(specOf(bot(["mcp__effects"]))))).toEqual(["memory", "effects"]);
});

test("the tool context follows the current conversation: a group save lands in the group file", async () => {
  const { root, memory } = build();
  const ctx = toolContext(specOf(bot([]), "gc"), store);
  const owner = await resolveOwner("group", ctx);
  expect(owner).toEqual({ kind: "group", groupId: "team" });
  if (typeof owner === "string") return;
  await memory.save(owner, "team uses bun");
  expect(readFileSync(join(root, "memory", "groups", "team", "MEMORY.md"), "utf8")).toContain(
    "team uses bun",
  );
  expect(await toolContext(specOf(bot([])), store).conversation()).toBeUndefined();
});

test("commands of the effect tools get only the allowed env names", () => {
  expect(
    commandEnv({ PATH: "/bin", HOME: "/h", GH_TOKEN: "g", DISCORD_TOKEN: "d", OAUTH: "o" }),
  ).toEqual({ PATH: "/bin", HOME: "/h", GH_TOKEN: "g" });
});
