import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBotDesignTool } from "../src/design/tools/BotDesignTool/bot-design-tool";
import { call, putSkill, setup, textOf } from "./design-fixture";

const bot = {
  action: "write_bot",
  id: "ann",
  name: "Ann",
  title: "backend dev",
  model: "sonnet",
  instructions: "Review PRs.",
};

test("write_bot writes bots/<id>.md with the header and the body", async () => {
  const { ctx, configDir } = setup();
  const r = await call(createBotDesignTool(ctx), {
    ...bot,
    tools: ["Read", "mcp__playwright"],
    skills: ["shipped-one"],
  });
  expect(r.isError).toBeUndefined();
  const text = readFileSync(join(configDir, "bots", "ann.md"), "utf8");
  expect(text).toContain("name: Ann");
  expect(text).toContain("mcp__playwright");
  expect(text.endsWith("---\nReview PRs.\n")).toBe(true);
});

test("write_bot refuses a bad id, the reserved id, an unknown tool, an unknown skill and a bad workspace", async () => {
  const { ctx, configDir, home } = setup();
  const t = createBotDesignTool(ctx);
  const bads = [
    { id: "../x" },
    { id: "Ann" },
    { id: "friday" },
    { tools: ["Nope"] },
    { tools: ["mcp__ghost"] },
    { skills: ["ghost"] },
    { workspaces: ["relative/dir"] },
    { workspaces: [join(configDir, "missing")] },
    { workspaces: [home] },
    { instructions: "   " },
  ];
  for (const b of bads) {
    const r = await call(t, { ...bot, ...b });
    expect(r.isError).toBe(true);
  }
  expect(existsSync(join(configDir, "bots", "ann.md"))).toBe(false);
});

test("write_bot accepts a real workspace outside the home and an mcp tool of a known server", async () => {
  const { ctx, base, configDir } = setup();
  const ws = join(base, "proj");
  mkdirSync(ws);
  const r = await call(createBotDesignTool(ctx), {
    ...bot,
    workspaces: [ws],
    tools: ["mcp__playwright__browser_navigate"],
  });
  expect(r.isError).toBeUndefined();
  expect(readFileSync(join(configDir, "bots", "ann.md"), "utf8")).toContain(ws);
});

test("write_bot lets the parser refuse a file and writes nothing; a taken name is refused", async () => {
  const bad = setup({
    checkBot: () => {
      throw new Error("name may not contain clyde");
    },
  });
  const r = await call(createBotDesignTool(bad.ctx), bot);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("clyde");
  expect(existsSync(join(bad.configDir, "bots", "ann.md"))).toBe(false);
  const taken = setup({ nameTaken: (n) => n === "Ann" });
  expect((await call(createBotDesignTool(taken.ctx), bot)).isError).toBe(true);
});

test("write_group writes groups/<id>.yaml; members must exist, friday cannot join", async () => {
  const { ctx, configDir } = setup({
    botSummaries: () => [
      { id: "friday", name: "Friday", title: "t" },
      { id: "ann", name: "Ann", title: "t" },
      { id: "bob", name: "Bob", title: "t" },
    ],
  });
  const t = createBotDesignTool(ctx);
  const ok = await call(t, {
    action: "write_group",
    id: "duo",
    name: "Duo",
    members: ["ann", "bob"],
    entryBot: "ann",
  });
  expect(ok.isError).toBeUndefined();
  expect(readFileSync(join(configDir, "groups", "duo.yaml"), "utf8")).toContain("entryBot: ann");
  for (const g of [
    { members: ["ann", "ghost"] },
    { members: ["ann", "friday"] },
    { entryBot: "bob", members: ["ann"] },
    { id: "../x" },
  ])
    expect(
      (
        await call(t, {
          action: "write_group",
          id: "g",
          name: "G",
          members: ["ann"],
          entryBot: "ann",
          ...g,
        })
      ).isError,
    ).toBe(true);
});

test("a skill name is known to write_bot after write_skill", async () => {
  const { ctx, configDir } = setup();
  putSkill(join(configDir, "skills"), "mine");
  expect(
    (await call(createBotDesignTool(ctx), { ...bot, skills: ["mine"] })).isError,
  ).toBeUndefined();
});

test("write_bot refuses autonomous, a tool of the design server and an existing bot without overwrite", async () => {
  const { ctx, configDir } = setup({ catalogTools: () => ["Read", "mcp__design__BotDesign"] });
  const t = createBotDesignTool(ctx);
  expect((await call(t, { ...bot, autonomy: "autonomous" })).isError).toBe(true);
  expect((await call(t, { ...bot, tools: ["mcp__design__BotDesign"] })).isError).toBe(true);
  expect((await call(t, { ...bot, tools: ["mcp__design"] })).isError).toBe(true);
  expect((await call(t, { ...bot, autonomy: "careful" })).isError).toBeUndefined();
  expect((await call(t, bot)).isError).toBe(true);
  expect(
    (await call(t, { ...bot, instructions: "New.", overwrite: true })).isError,
  ).toBeUndefined();
  expect(readFileSync(join(configDir, "bots", "ann.md"), "utf8")).toContain("New.");
});

test("overwriting a bot keeps its subagents", async () => {
  const { ctx, configDir } = setup();
  writeFileSync(
    join(configDir, "bots", "ann.md"),
    "---\nname: Ann\ntitle: t\nmodel: m\nsubagents:\n  - name: helper\n    description: d\n    prompt: p\n---\nOld.\n",
  );
  const r = await call(createBotDesignTool(ctx), { ...bot, overwrite: true });
  expect(r.isError).toBeUndefined();
  const text = readFileSync(join(configDir, "bots", "ann.md"), "utf8");
  expect(text).toContain("helper");
  expect(text).toContain("Review PRs.");
});

test("overwriting a bot keeps its avatar when none is given", async () => {
  const { ctx, configDir } = setup();
  const file = join(configDir, "bots", "ann.md");
  const up = `upload:${"b".repeat(36)}`;
  writeFileSync(file, `---\nname: Ann\ntitle: t\nmodel: m\navatar: ${up}\n---\nOld.\n`);
  expect(
    (await call(createBotDesignTool(ctx), { ...bot, overwrite: true })).isError,
  ).toBeUndefined();
  expect(readFileSync(file, "utf8")).toContain(`avatar: ${up}`);
});

const helper = { name: "scout", description: "Finds files.", prompt: "Find the files asked for." };

test("write_bot writes given subagents and replaces the old ones; [] removes them", async () => {
  const { ctx, configDir } = setup();
  const file = join(configDir, "bots", "ann.md");
  writeFileSync(
    file,
    "---\nname: Ann\ntitle: t\nmodel: m\nsubagents:\n  - name: helper\n    description: d\n    prompt: p\n---\nOld.\n",
  );
  const t = createBotDesignTool(ctx);
  const r = await call(t, {
    ...bot,
    tools: ["Read", "Grep", "Agent"],
    subagents: [{ ...helper, tools: ["Read"], model: "haiku", effort: "low" }],
    overwrite: true,
  });
  expect(r.isError).toBeUndefined();
  const text = readFileSync(file, "utf8");
  expect(text).toContain("scout");
  expect(text).toContain("model: haiku");
  expect(text).not.toContain("helper");
  await call(t, { ...bot, subagents: [], overwrite: true });
  expect(readFileSync(file, "utf8")).not.toContain("subagents");
});

test("write_bot refuses a subagent tool the bot lacks (a design tool, an unknown tool)", async () => {
  const { ctx, configDir } = setup();
  const t = createBotDesignTool(ctx);
  const bads = [
    [{ ...helper, tools: ["Grep"] }],
    [{ ...helper, tools: ["mcp__design"] }],
    [{ ...helper, tools: ["Nope"] }],
  ];
  const noAgent = await call(t, { ...bot, tools: ["Read"], subagents: [helper] });
  expect(textOf(noAgent)).toContain("needs Agent");
  for (const subagents of bads) {
    const r = await call(t, { ...bot, tools: ["Read", "Agent"], subagents });
    expect(r.isError).toBe(true);
  }
  expect(existsSync(join(configDir, "bots", "ann.md"))).toBe(false);
});

test("write_group refuses an existing group without overwrite", async () => {
  const { ctx } = setup({ botSummaries: () => [{ id: "ann", name: "Ann", title: "t" }] });
  const t = createBotDesignTool(ctx);
  const g = { action: "write_group", id: "solo", name: "Solo", members: ["ann"], entryBot: "ann" };
  expect((await call(t, g)).isError).toBeUndefined();
  expect((await call(t, g)).isError).toBe(true);
  expect((await call(t, { ...g, overwrite: true })).isError).toBeUndefined();
});

test("write_bot refuses a tool named twice (padding of the approval card)", async () => {
  const { ctx } = setup();
  const t = createBotDesignTool(ctx);
  const r = await call(t, {
    action: "write_bot",
    id: "dup",
    name: "Dup",
    instructions: "Do it.",
    tools: ["Read", "Read"],
  });
  expect(r.isError).toBe(true);
});

test("write_bot writes effort and maxEffort into the header", async () => {
  const { ctx, configDir } = setup();
  const t = createBotDesignTool(ctx);
  const r = await call(t, {
    action: "write_bot",
    id: "thinker",
    name: "Thinker",
    title: "Planner",
    model: "sonnet",
    instructions: "Plan.",
    effort: "medium",
    maxEffort: "high",
  });
  expect(r.isError).toBeUndefined();
  const text = readFileSync(join(configDir, "bots", "thinker.md"), "utf8");
  expect(text).toContain("effort: medium");
  expect(text).toContain("maxEffort: high");
});

const grp = { action: "write_group", id: "duo", name: "Duo", members: ["ann"], entryBot: "ann" };
const annOnly = { botSummaries: () => [{ id: "ann", name: "Ann", title: "t" }] };

test("write_group writes workspaces and instructions", async () => {
  const { ctx, configDir, scratchDir } = setup(annOnly);
  const dir = join(scratchDir, "..", "..", "..", "ws");
  mkdirSync(dir, { recursive: true });
  const r = await call(createBotDesignTool(ctx), {
    ...grp,
    workspaces: [dir],
    instructions: "Be nice.",
  });
  expect(r.isError).toBeUndefined();
  const parsed = Bun.YAML.parse(readFileSync(join(configDir, "groups", "duo.yaml"), "utf8")) as {
    workspaces: string[];
    instructions: string;
  };
  expect(parsed.workspaces).toEqual([dir]);
  expect(parsed.instructions).toBe("Be nice.");
});

test("write_group refuses a missing workspace and one inside the agent home", async () => {
  const { ctx } = setup(annOnly);
  const t = createBotDesignTool(ctx);
  for (const w of ["/no/such/dir-xyz", ctx.scratchDir])
    expect((await call(t, { ...grp, workspaces: [w] })).isError).toBe(true);
});

test("write_group overwrite keeps workspaces and instructions that are not given", async () => {
  const { ctx, configDir, scratchDir } = setup(annOnly);
  const dir = join(scratchDir, "..", "..", "..", "ws");
  mkdirSync(dir, { recursive: true });
  const t = createBotDesignTool(ctx);
  await call(t, { ...grp, workspaces: [dir], instructions: "Keep me." });
  expect((await call(t, { ...grp, name: "Duo2", overwrite: true })).isError).toBeUndefined();
  const file = join(configDir, "groups", "duo.yaml");
  const parsed = Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  expect(parsed.name).toBe("Duo2");
  expect(parsed.workspaces).toEqual([dir]);
  expect(parsed.instructions).toBe("Keep me.");
  // An avatar set elsewhere (the web app) survives an overwrite.
  writeFileSync(file, `${readFileSync(file, "utf8")}avatar: upload:${"a".repeat(36)}\n`);
  await call(t, { ...grp, overwrite: true });
  expect((Bun.YAML.parse(readFileSync(file, "utf8")) as { avatar?: string }).avatar).toBe(
    `upload:${"a".repeat(36)}`,
  );
  // A malformed existing file is treated as having no values.
  writeFileSync(file, "{ not: yaml: [");
  expect((await call(t, { ...grp, overwrite: true })).isError).toBeUndefined();
});

test("a new group without workspaces or instructions writes no empty keys", async () => {
  const { ctx, configDir } = setup(annOnly);
  await call(createBotDesignTool(ctx), grp);
  const text = readFileSync(join(configDir, "groups", "duo.yaml"), "utf8");
  expect(text).not.toContain("workspaces");
  expect(text).not.toContain("instructions");
});

test("write_bot refuses a title over 80 chars and writes nothing", async () => {
  const { ctx, configDir } = setup();
  const r = await call(createBotDesignTool(ctx), { ...bot, title: "x".repeat(81) });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("80");
  expect(existsSync(join(configDir, "bots", "ann.md"))).toBe(false);
});
