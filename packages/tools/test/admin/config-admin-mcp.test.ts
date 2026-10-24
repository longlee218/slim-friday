import { beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigAdmin, McpServerInput } from "@friday/core";
import { createConfigAdmin } from "../../src/admin/config-admin";
import { setup } from "../design-fixture";

const gh: McpServerInput = { type: "http", url: "https://x", headers: { A: "${GH_TOKEN}" } };
let configDir: string;
let admin: ConfigAdmin;

beforeEach(() => {
  const s = setup();
  configDir = s.configDir;
  const defaultsDir = join(s.base, "defaults");
  mkdirSync(defaultsDir);
  writeFileSync(
    join(defaultsDir, "mcp.yaml"),
    "servers:\n  playwright:\n    type: stdio\n    command: npx\n",
  );
  writeFileSync(
    join(configDir, "bots", "dev.md"),
    "---\nname: Dev\ntools: [Read, mcp__gh__search]\n---\nHi\n",
  );
  writeFileSync(join(configDir, "bots", "broken.md"), "---\nname: [unclosed\n---\n");
  admin = createConfigAdmin({
    ...s.ctx,
    defaultsDir,
    readBotFile: (id) => {
      const f = join(configDir, "bots", `${id}.md`);
      return existsSync(f) ? readFileSync(f, "utf8") : undefined;
    },
    mcpNames: () => [
      "playwright",
      ...(existsSync(join(configDir, "mcp.yaml")) &&
      readFileSync(join(configDir, "mcp.yaml"), "utf8").includes("gh:")
        ? ["gh"]
        : []),
    ],
  });
});

const bad = (code: string) => expect.objectContaining({ code });

test("refuses a literal secret in a header", () => {
  expect(() =>
    admin.saveMcp(
      "gh",
      { type: "http", url: "https://x", headers: { Authorization: "Bearer abc" } },
      "create",
    ),
  ).toThrow(bad("BAD_REQUEST"));
  expect(existsSync(join(configDir, "mcp.yaml"))).toBe(false);
});

test("refuses an engine secret, a reserved name", () => {
  expect(() =>
    admin.saveMcp(
      "gh",
      { type: "stdio", command: "x", env: { T: "${CLAUDE_CODE_OAUTH_TOKEN}" } },
      "create",
    ),
  ).toThrow(bad("BAD_REQUEST"));
  expect(() => admin.saveMcp("memory", gh, "create")).toThrow(bad("BAD_REQUEST"));
});

test("create and update modes", () => {
  expect(() => admin.saveMcp("gh", gh, "update")).toThrow(bad("NOT_FOUND"));
  admin.saveMcp("gh", gh, "create");
  expect(() => admin.saveMcp("gh", gh, "create")).toThrow(bad("CONFLICT"));
  expect(() => admin.saveMcp("playwright", gh, "create")).toThrow(bad("CONFLICT"));
  expect(() => admin.saveMcp("playwright", gh, "update")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST", message: "shipped servers are read only" }),
  );
  admin.saveMcp("gh", { ...gh, url: "https://y" }, "update");
  expect(readFileSync(join(configDir, "mcp.yaml"), "utf8")).toContain("https://y");
});

test("refuses a write through a symlinked mcp.yaml", () => {
  const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "m.yaml");
  symlinkSync(outside, join(configDir, "mcp.yaml"));
  expect(() => admin.saveMcp("gh", gh, "create")).toThrow(bad("BAD_REQUEST"));
  expect(existsSync(outside)).toBe(false);
});

test("lists shipped and owner servers with usedBy, despite a broken bot file", () => {
  admin.saveMcp("gh", gh, "create");
  const list = admin.listMcp();
  expect(list.find((e) => e.name === "playwright")).toMatchObject({ shipped: true, usedBy: [] });
  expect(list.find((e) => e.name === "gh")).toMatchObject({ shipped: false, usedBy: ["dev"] });
});

test("delete refuses shipped and used servers, removes unused ones", () => {
  expect(() => admin.deleteMcp("playwright")).toThrow(bad("BAD_REQUEST"));
  admin.saveMcp("gh", gh, "create");
  expect(() => admin.deleteMcp("gh")).toThrow(
    expect.objectContaining({ code: "CONFLICT", message: expect.stringContaining("dev") }),
  );
  admin.saveMcp("other", gh, "create");
  admin.deleteMcp("other");
  expect(admin.listMcp().some((e) => e.name === "other")).toBe(false);
  expect(() => admin.deleteMcp("other")).toThrow(bad("NOT_FOUND"));
});

test("checkMcpServer checks and writes nothing", () => {
  admin.checkMcpServer("gh", gh);
  expect(existsSync(join(configDir, "mcp.yaml"))).toBe(false);
  expect(() =>
    admin.checkMcpServer("gh", { type: "http", url: "https://x", headers: { A: "lit" } }),
  ).toThrow(bad("BAD_REQUEST"));
});
