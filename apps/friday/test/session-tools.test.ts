import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec, Store } from "@friday/core";
import { FileMemory, MemoryRecall, resolveOwner } from "@friday/tools";
import {
  commandEnv,
  ownerIdentityEnv,
  runCommand,
  sensitiveCheck,
  sessionScratchDir,
  sessionTools,
  toolContext,
} from "../src/session-tools";

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
    recall: new MemoryRecall([]),
    store,
    home: root,
    projectsDir: () => join(root, "projects"),
    isSensitive: () => false,
    postFile: async () => {},
  });
  return { root, memory, forSpec };
}

test("every bot gets the memory server; only a bot that names an effect tool gets effects", () => {
  const { forSpec } = build();
  expect(Object.keys(forSpec(specOf(bot(["Read"]))))).toEqual(["memory", "chat"]);
  expect(Object.keys(forSpec(specOf(bot(["mcp__effects__GitPush"]))))).toEqual([
    "memory",
    "chat",
    "effects",
  ]);
  expect(Object.keys(forSpec(specOf(bot(["mcp__effects"]))))).toEqual([
    "memory",
    "chat",
    "effects",
  ]);
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

test("runCommand passes only the given env and reports the exit code", async () => {
  const r = await runCommand(["sh", "-c", 'echo "$KEEP-$DROP"; exit 3'], tmpdir(), {
    KEEP: "k",
    PATH: "/bin:/usr/bin",
  });
  expect(r).toEqual({ code: 3, out: "k-\n" });
});

test("the sensitive check works from the real workspace path (a symlinked workspace too)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sens-")));
  mkdirSync(join(root, "real", "keys-docs"), { recursive: true });
  symlinkSync(join(root, "real"), join(root, "ws"));
  const seen: string[] = [];
  const check = sensitiveCheck([join(root, "ws")], (rel) => {
    seen.push(rel);
    return rel.endsWith(".env");
  });
  expect(check(join(root, "real", "a", ".env"))).toBe(true);
  expect(check(join(root, "real", "keys-docs", "a.md"))).toBe(false);
  expect(seen).toContain(join("a", ".env"));
});

test("the owner's git identity becomes env, so merge commits have an author", () => {
  const read = (k: string) => ({ "user.name": "Ann Owner", "user.email": "a@x.io" })[k];
  expect(ownerIdentityEnv(read, {})).toEqual({
    GIT_AUTHOR_NAME: "Ann Owner",
    GIT_AUTHOR_EMAIL: "a@x.io",
    GIT_COMMITTER_NAME: "Ann Owner",
    GIT_COMMITTER_EMAIL: "a@x.io",
  });
  // An identity already in the env wins; nothing is read.
  expect(ownerIdentityEnv(read, { GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "y" })).toEqual({});
});

test("the chat server's scratch dir is the session's: <botId> direct, <botId>_<groupId> in a group", () => {
  const editor = { ...bot([]), id: "editor" };
  expect(sessionScratchDir("/h", specOf(editor))).toBe(join("/h", "scratch", "editor"));
  expect(
    sessionScratchDir("/h", { ...specOf(editor), groupId: "reelme", sessionKey: "editor@reelme" }),
  ).toBe(join("/h", "scratch", "editor_reelme"));
});
