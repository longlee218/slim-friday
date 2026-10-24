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
      throw new Error("name may not contain discord");
    },
  });
  const r = await call(createBotDesignTool(bad.ctx), bot);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("discord");
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
