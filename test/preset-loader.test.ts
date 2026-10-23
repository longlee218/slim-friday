import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPresets } from "../src/presets/preset-loader";

/* Roles as files: a bad file refuses the load naming the file; a new folder is a new role with no code change. */

const REPO = join(import.meta.dir, "..", "config", "presets");

/** A throwaway presets dir holding the shared partials and a copy of the scout. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "presets-"));
  cpSync(join(REPO, "_partials"), join(dir, "_partials"), { recursive: true });
  cpSync(join(REPO, "scout"), join(dir, "scout"), { recursive: true });
  return dir;
}
const edit = (dir: string, file: string, fn: (s: string) => string) => {
  const p = join(dir, file);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
};

test("the shipped presets load", () => {
  expect(Object.keys(loadPresets(REPO)).length).toBeGreaterThanOrEqual(10);
});

test("a new folder is a new role (no code change)", () => {
  const dir = sandbox();
  cpSync(join(dir, "scout"), join(dir, "scout2"), { recursive: true });
  edit(dir, "scout2/preset.yaml", (s) => s.replace("name: scout", "name: scout2"));
  const roles = loadPresets(dir);
  expect(Object.keys(roles).sort()).toEqual(["scout", "scout2"]);
  expect(roles.scout2?.promptSections()[0]).toContain("Role: scout");
});

test("an unknown tool id, a bad alias, an extra key and a name that is not the folder are refused with the file", () => {
  for (const [from, to] of [
    ["  - Report\n", "  - NoSuchTool\n"],
    ["model: haiku", "model: gpt"],
    ["kind: worker", "kind: worker\nsurprise: 1"],
    ["name: scout", "name: other"],
  ] as const) {
    const dir = sandbox();
    edit(dir, "scout/preset.yaml", (s) => s.replace(from, to));
    expect(() => loadPresets(dir)).toThrow("scout/preset.yaml");
  }
});

test("an unknown variable or partial in prompt.md is refused with the file", () => {
  const a = sandbox();
  edit(a, "scout/prompt.md", (s) => `${s}\n{{tool.NoSuchTool}}\n`);
  expect(() => loadPresets(a)).toThrow("unknown variable {{tool.NoSuchTool}}");
  const b = sandbox();
  edit(b, "scout/prompt.md", (s) => `${s}\n{{> nope}}\n`);
  expect(() => loadPresets(b)).toThrow("unknown partial");
});

test("a standalone partial keeps the line break after it", () => {
  const dir = sandbox();
  mkdirSync(join(dir, "_partials"), { recursive: true });
  writeFileSync(join(dir, "_partials", "p.md"), "P1\nP2\n");
  edit(dir, "scout/prompt.md", () => "A\n\n{{> p}}\n\nB\n");
  expect(loadPresets(dir).scout?.promptSections()[0]).toBe("A\n\nP1\nP2\n\nB");
});
