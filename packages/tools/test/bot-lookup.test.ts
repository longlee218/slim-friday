import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBotLookupTool } from "../src/design/tools/BotLookupTool/bot-lookup-tool";
import { call, putSkill, setup, textOf } from "./design-fixture";

test("list shows bots, groups, skills with descriptions, MCP servers and tool names", async () => {
  const { ctx, configDir } = setup({
    groupSummaries: () => [{ id: "duo", name: "Duo", members: ["ann", "bob"] }],
  });
  putSkill(join(configDir, "skills"), "mine", "Mine does mine things.");
  const text = textOf(await call(createBotLookupTool(ctx), { action: "list" }));
  for (const s of [
    "friday",
    "team builder",
    "duo",
    "shipped-one",
    "mine: Mine does mine things.",
    "playwright",
    "GitPush",
  ])
    expect(text).toContain(s);
});

test("read_bot reads the owner file first, then the shipped one; read_skill reads SKILL.md", async () => {
  const { ctx, configDir } = setup();
  const t = createBotLookupTool(ctx);
  expect(textOf(await call(t, { action: "read_bot", id: "friday" }))).toContain("Shipped.");
  writeFileSync(join(configDir, "bots", "friday.md"), "owner copy\n");
  expect(textOf(await call(t, { action: "read_bot", id: "friday" }))).toContain("owner copy");
  expect(textOf(await call(t, { action: "read_skill", id: "shipped-one" }))).toContain("Body");
});

test("read_bot and read_skill refuse an id that is not a plain name, and say when nothing is found", async () => {
  const { ctx } = setup();
  const t = createBotLookupTool(ctx);
  for (const action of ["read_bot", "read_skill"]) {
    expect((await call(t, { action, id: "../../etc/passwd" })).isError).toBe(true);
    expect((await call(t, { action, id: "ghost" })).isError).toBe(true);
  }
});
