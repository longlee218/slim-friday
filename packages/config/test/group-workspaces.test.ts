import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Group } from "@friday/core";
import { diffGroups } from "../src/diff-groups";
import { FileConfig } from "../src/file-config";
import { DEFAULTS_DIR } from "../src/load-config";
import { parseGroupFile } from "../src/schemas/group-file";

const base = "name: G\nmembers: [a]\nentryBot: a\n";
const group = (over: Partial<Group> = {}): Group => ({
  id: "g",
  name: "G",
  members: ["a"],
  entryBot: "a",
  workspaces: [],
  instructions: "",
  ...over,
});

test("parseGroupFile reads workspaces and instructions, defaults to [] and empty", () => {
  const g = parseGroupFile("g", `${base}workspaces: [/tmp/p1]\ninstructions: "Reelme app"\n`);
  expect(g.workspaces).toEqual(["/tmp/p1"]);
  expect(g.instructions).toBe("Reelme app");
  const d = parseGroupFile("g", base);
  expect(d.workspaces).toEqual([]);
  expect(d.instructions).toBe("");
});

test("a relative or duplicate workspace path throws", () => {
  expect(() => parseGroupFile("g", `${base}workspaces: [rel/p]\n`)).toThrow();
  expect(() => parseGroupFile("g", `${base}workspaces: [/tmp/p, /tmp/p]\n`)).toThrow();
});

test("diffGroups: workspaces change and removal count, instructions do not", () => {
  const prev = new Map([["g", group()]]);
  expect(diffGroups(prev, new Map([["g", group({ workspaces: ["/tmp/p"] })]]))).toEqual(["g"]);
  expect(diffGroups(prev, new Map([["g", group({ instructions: "x" })]]))).toEqual([]);
  expect(diffGroups(prev, new Map())).toEqual(["g"]);
});

test("reload reports a group whose workspaces changed, and no bots", () => {
  const dir = mkdtempSync(join(tmpdir(), "gws-"));
  const put = (extra: string) => {
    mkdirSync(join(dir, "bots"), { recursive: true });
    mkdirSync(join(dir, "groups"), { recursive: true });
    writeFileSync(
      join(dir, "bots", "a.md"),
      "---\nname: A\ntitle: T\nmodel: sonnet\n---\nBe brief.\n",
    );
    writeFileSync(join(dir, "groups", "g.yaml"), base + extra);
  };
  put("");
  const { config } = FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir: dir });
  put("workspaces: [/tmp/p1]\n");
  const r = config.reload();
  expect(r.changedGroups).toEqual(["g"]);
  expect(r.changedBots).toEqual([]);
});
