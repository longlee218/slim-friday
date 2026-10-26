import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBotFile } from "@friday/config";
import type { BotInput, ConfigAdmin } from "@friday/core";
import { createConfigAdmin } from "../../src/admin/config-admin";
import { createBotDesignTool } from "../../src/design/tools/BotDesignTool/bot-design-tool";
import { call, setup, textOf } from "../design-fixture";

const friday: BotInput = {
  id: "friday",
  name: "Friday",
  title: "team builder",
  model: "sonnet",
  instructions: "Build bots.",
  tools: ["Read", "mcp__design__BotDesign"],
  skills: [],
  workspaces: [],
};

let configDir: string;
let admin: ConfigAdmin;

beforeEach(() => {
  const s = setup();
  configDir = s.configDir;
  const shipped = join(configDir, "..", "..", "shipped-bots", "friday.md");
  // A shipped file the real parser accepts (the fixture's stand-in has no title or model).
  writeFileSync(shipped, "---\nname: Friday\ntitle: team builder\nmodel: sonnet\n---\nShipped.\n");
  admin = createConfigAdmin({
    ...s.ctx,
    ownerBotIds: ["friday"],
    catalogTools: () => ["Read", "mcp__design__BotDesign"],
    checkBot: (id, text) => void parseBotFile(id, text),
    readBotFile: (id) => {
      const own = join(configDir, "bots", `${id}.md`);
      if (existsSync(own)) return readFileSync(own, "utf8");
      return id === "friday" ? readFileSync(shipped, "utf8") : undefined;
    },
  });
});

test("Friday is listed as editable, not shipped", () => {
  expect(admin.getBot("friday").shipped).toBe(false);
});

test("the owner's first save writes an override of Friday, design tools included", () => {
  admin.saveBot(friday, "update");
  const file = join(configDir, "bots", "friday.md");
  expect(parseBotFile("friday", readFileSync(file, "utf8")).tools).toContain(
    "mcp__design__BotDesign",
  );
});

test("a refused first save leaves no override behind", () => {
  expect(() => admin.saveBot({ ...friday, tools: ["Nope"] }, "update")).toThrow();
  expect(existsSync(join(configDir, "bots", "friday.md"))).toBe(false);
});

test("Friday cannot be deleted", () => {
  admin.saveBot(friday, "update");
  expect(() => admin.deleteBot("friday")).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  expect(existsSync(join(configDir, "bots", "friday.md"))).toBe(true);
});

test("an avatar change on Friday writes the override", () => {
  admin.setAvatar({ kind: "bot", id: "friday" }, "fox");
  expect(readFileSync(join(configDir, "bots", "friday.md"), "utf8")).toContain("avatar: fox");
});

test("the BotDesign tool still refuses the id friday, even with the owner list set", async () => {
  const s = setup();
  const ctx = { ...s.ctx, ownerBotIds: ["friday"] };
  const r = await call(createBotDesignTool(ctx), {
    action: "write_bot",
    ...friday,
    overwrite: true,
  });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("reserved");
});

test("Friday is never deletable, before or after an override", () => {
  expect(admin.getBot("friday").deletable).toBe(false);
  admin.saveBot(friday, "update");
  expect(admin.getBot("friday").deletable).toBe(false);
});
