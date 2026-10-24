import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig } from "@friday/config";
import type { Bot, BotRuntimeSpec, Store } from "@friday/core";
import { openEngineStore } from "@friday/store-sqlite";
import { createBotDesignTool, createBotInsightTool, FileMemory, MemoryRecall } from "@friday/tools";
import { designContextFor } from "../src/design-context";
import { sessionTools } from "../src/session-tools";

type Result = { content: { text: string }[]; isError?: boolean };
const call = (t: { handler: (a: never, e: unknown) => Promise<unknown> }, args: object) =>
  t.handler(args as never, {}) as Promise<Result>;

const bot = (tools: string[]): Bot => ({
  id: "friday",
  name: "Friday",
  title: "t",
  model: "m",
  instructions: "",
  tools,
  workspaces: [],
  skills: [],
  subagents: [],
});
const specOf = (b: Bot): BotRuntimeSpec => ({
  bot: b,
  decide: async () => ({ behavior: "allow" }),
});

/** A home with a config dir, a real FileConfig over it and the design context of the Friday bot. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "dctx-"));
  const configDir = join(home, "config");
  mkdirSync(join(configDir, "bots"), { recursive: true });
  const { config } = FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir: configDir });
  const run = async () => ({ code: 0, out: "deadbeef\n" });
  const engine = openEngineStore(":memory:");
  const ctx = {
    ...designContextFor({ config, agentHome: home })(specOf(bot([])), run),
    memory: new FileMemory(join(home, "memory")),
    insight: engine.insight,
    messages: engine.messages,
  };
  return { home, configDir, config, ctx, engine };
}

test("a bot written through BotDesign loads on the next reload; the real parser refuses a bad file", async () => {
  const { config, ctx, configDir } = setup();
  const t = createBotDesignTool(ctx);
  const ok = await call(t, {
    action: "write_bot",
    id: "ann",
    name: "Ann",
    title: "backend dev",
    model: "sonnet",
    tools: ["Read", "Grep"],
    skills: ["bot-design"],
    instructions: "Review code.",
  });
  expect(ok.isError).toBeUndefined();
  const r = config.reload();
  expect(r.problems).toEqual([]);
  const ann = await config.bots.get("ann");
  expect(ann?.tools).toEqual(["Read", "Grep"]);
  expect(ann?.skills).toEqual(["bot-design"]);
  const bad = await call(t, {
    action: "write_bot",
    id: "bob",
    name: "Discord",
    title: "t",
    model: "m",
    instructions: "x",
  });
  expect(bad.isError).toBe(true);
  writeFileSync(
    join(configDir, "bots", "keep.md"),
    "---\nname: Keep\ntitle: t\nmodel: m\n---\nx\n",
  );
  expect(ctx.nameTaken("keep", "other")).toBe(false); // the snapshot is read again only on reload
  config.reload();
  expect(ctx.nameTaken("keep", "other")).toBe(true);
});

test("the shipped skills and the real catalog are what the design context offers; friday stays reserved", () => {
  const { ctx } = setup();
  expect(ctx.reservedBotIds).toContain("friday");
  expect(ctx.catalogTools()).toContain("Bash");
  expect(ctx.mcpNames()).toContain("playwright");
  expect(ctx.skillDirs.at(-1)).toMatch(/defaults\/skills$/);
  expect(ctx.botDirs.at(-1)).toMatch(/defaults\/bots$/);
  expect(ctx.scratchDir.endsWith(join("scratch", "friday"))).toBe(true);
});

test("gitHead reads the commit through the injected runner", async () => {
  const { ctx } = setup();
  expect(await ctx.gitHead("/x")).toBe("deadbeef");
});

test("sessionTools adds the design server only for a bot that names it", () => {
  const home = mkdtempSync(join(tmpdir(), "dst-"));
  const { config } = FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir: join(home, "config") });
  const forSpec = sessionTools({
    memory: new FileMemory(join(home, "memory")),
    recall: new MemoryRecall([]),
    store: {} as unknown as Store,
    home,
    projectsDir: () => join(home, "projects"),
    isSensitive: () => false,
    postFile: async () => {},
    design: designContextFor({ config, agentHome: home }),
  });
  expect(Object.keys(forSpec(specOf(bot(["Read"]))))).not.toContain("design");
  expect(Object.keys(forSpec(specOf(bot(["mcp__design__BotDesign"]))))).toContain("design");
  expect(Object.keys(forSpec(specOf(bot(["mcp__design"]))))).toContain("design");
  // Only the Friday bot gets the design tools, whatever another bot names.
  const other = { ...bot(["mcp__design__BotDesign"]), id: "ann" };
  expect(Object.keys(forSpec(specOf(other)))).not.toContain("design");
});

test("the design scratch dir is the session's: <botId> direct, <botId>_<groupId> in a group", () => {
  const { home, config } = setup();
  const forSpec = designContextFor({ config, agentHome: home });
  const run = async () => ({ code: 0, out: "" });
  const ann = { ...bot([]), id: "ann" };
  expect(forSpec(specOf(ann), run).scratchDir).toBe(join(home, "scratch", "ann"));
  const group = { ...specOf(ann), groupId: "reelme", sessionKey: "ann@reelme" };
  expect(forSpec(group, run).scratchDir).toBe(join(home, "scratch", "ann_reelme"));
});

test("subagents written through BotDesign load with the bot; the real parser refuses a duplicate name", async () => {
  const { config, ctx } = setup();
  const t = createBotDesignTool(ctx);
  const ann = {
    action: "write_bot",
    id: "ann",
    name: "Ann",
    title: "t",
    model: "sonnet",
    tools: ["Read", "Grep", "Agent"],
    instructions: "x",
  };
  const scout = { name: "scout", description: "Finds files.", prompt: "Find.", tools: ["Grep"] };
  const dup = await call(t, { ...ann, subagents: [scout, scout] });
  expect(dup.isError).toBe(true);
  const ok = await call(t, { ...ann, subagents: [{ ...scout, effort: "low" }] });
  expect(ok.isError).toBeUndefined();
  expect(config.reload().problems).toEqual([]);
  const loaded = await config.bots.get("ann");
  expect(loaded?.subagents.map((s) => [s.name, s.tools, s.effort])).toEqual([
    ["scout", ["Grep"], "low"],
  ]);
});

test("delete_bot removes a written bot on the next reload; add_lesson reaches its memory first", async () => {
  const { config, ctx, home } = setup();
  const t = createBotDesignTool(ctx);
  const base = {
    action: "write_bot",
    id: "ann",
    name: "Ann",
    title: "t",
    model: "sonnet",
    instructions: "x",
  };
  expect((await call(t, base)).isError).toBeUndefined();
  config.reload();
  const lesson = await call(t, {
    action: "add_lesson",
    id: "ann",
    lesson: "Ask before deleting files.",
  });
  expect(lesson.isError).toBeUndefined();
  expect(await new FileMemory(join(home, "memory")).read({ kind: "bot", botId: "ann" })).toContain(
    "Ask before deleting files.",
  );
  expect((await call(t, { action: "delete_bot", id: "ann" })).isError).toBeUndefined();
  config.reload();
  expect(await config.bots.get("ann")).toBeUndefined();
});

test("BotInsight reads the engine's own run steps: a skill in the bot file never used is reported", async () => {
  const { config, ctx, engine } = setup();
  const design = createBotDesignTool(ctx);
  await call(design, {
    action: "write_bot",
    id: "ann",
    name: "Ann",
    title: "dev",
    model: "sonnet",
    tools: ["Read", "Bash"],
    skills: ["bot-design", "find-skill"],
    instructions: "Build things.",
  });
  config.reload();
  await engine.messages.append({
    conversationId: "bot:ann",
    author: { kind: "bot", botId: "ann" },
    text: "done",
    at: Date.now(),
    run: [
      {
        id: "s",
        kind: "skill",
        label: "Used skill",
        target: "bot-design",
        state: "done",
        startedAt: 1,
        endedAt: 2,
      },
      {
        id: "c",
        kind: "command",
        label: "Ran",
        target: "bun test",
        state: "failed",
        startedAt: 3,
        endedAt: 4,
      },
    ],
  });
  const r = await call(createBotInsightTool(ctx), { action: "bot_report", id: "ann" });
  const text = r.content.map((c) => c.text).join("");
  expect(text).toContain("skill bot-design: 1 uses, 0 failed");
  expect(text).toContain("command Bash: 1 uses, 1 failed");
  expect(text).toMatch(/Unused in 30 days:[\s\S]*skill find-skill/);
});
