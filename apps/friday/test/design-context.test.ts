import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig } from "@friday/config";
import type { Bot, BotRuntimeSpec, Store } from "@friday/core";
import { createBotDesignTool, FileMemory } from "@friday/tools";
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
  const ctx = designContextFor({ config, agentHome: home })(specOf(bot([])), run);
  return { home, configDir, config, ctx };
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
});
