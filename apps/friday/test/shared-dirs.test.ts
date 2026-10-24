import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "@friday/core";
import { sessionSharedDirs, sharedDirsFor, withSharedDirs } from "../src/shared-dirs";

const bot = { id: "ann", name: "Ann", instructions: "Be brief." } as Bot;

test("a bot gets one shared dir per group it is in: created, writable, and none for a loner", () => {
  const home = mkdtempSync(join(tmpdir(), "shared-"));
  const dirsFor = sharedDirsFor(home, (id) => (id === "ann" ? ["duo", "trio"] : []));
  expect(dirsFor("ann")).toEqual([join(home, "shared", "duo"), join(home, "shared", "trio")]);
  expect(existsSync(join(home, "shared", "duo"))).toBe(true);
  expect(dirsFor("loner")).toEqual([]);
});

test("the instructions name the shared dirs; a bot without one is returned unchanged", () => {
  const out = withSharedDirs(bot, ["/h/shared/duo"]);
  expect(out.instructions).toContain("/h/shared/duo");
  expect(out.instructions.startsWith("Be brief.")).toBe(true);
  expect(withSharedDirs(bot, [])).toBe(bot);
});

test("a session's shared dirs: a group session gets its group's only, a direct session every group's", () => {
  const home = mkdtempSync(join(tmpdir(), "shared-"));
  const dirsOf = sessionSharedDirs(home, () => ["team", "crew"]);
  expect(dirsOf("ann", "team")).toEqual([join(home, "shared", "team")]);
  expect(dirsOf("ann")).toEqual([join(home, "shared", "team"), join(home, "shared", "crew")]);
});
