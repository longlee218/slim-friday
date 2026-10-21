import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Location } from "../src/locations/location-registry";
import {
  buildLocationRulesContext,
  LOCATION_RULES_FILE_MAX,
} from "../src/locations/location-rules";
import { buildPromptContext } from "../src/memory/prompt-context";
import { makeEnv } from "./helpers";

/** A location dir with the given files (relative path -> content). */
function repo(files: Record<string, string>): Location {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "rules-")));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(path, rel, ".."), { recursive: true });
    writeFileSync(join(path, rel), body);
  }
  return { name: "api", workspace: "main", path, description: "", git: true };
}

test("CLAUDE.md, its @import and .claude/rules in order, headings pushed under the file heading", () => {
  const l = repo({
    "CLAUDE.md": "# Guide\nUse Go.\n@DESIGN.md\n",
    "DESIGN.md": "# Design\nDESIGN_MARK",
    ".claude/rules/b.md": "B_MARK",
    ".claude/rules/a/x.md": "A_MARK",
    ".claude/rules/skip.txt": "TXT_MARK",
  });
  const text = buildLocationRulesContext([l]);
  expect(text).toStartWith(`## Location rules: api\n\nThe rules of ${l.path}`);
  expect(text).toContain("### CLAUDE.md\n\n#### Guide");
  const order = [
    "### CLAUDE.md",
    "### DESIGN.md",
    "### .claude/rules/a/x.md",
    "### .claude/rules/b.md",
  ];
  const at = order.map((h) => text.indexOf(h));
  expect(at.every((n) => n >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(text).not.toContain("TXT_MARK");
});

test("an import or rule outside the location, a sensitive file or a missing file is never read", () => {
  const outside = repo({ "secret.md": "OUTSIDE_MARK" });
  const l = repo({
    "CLAUDE.md": "@../x.md\n@missing.md\n@keys/k.md\n",
    "keys/k.md": "KEY_MARK",
  });
  mkdirSync(join(l.path, ".claude", "rules"), { recursive: true });
  symlinkSync(join(outside.path, "secret.md"), join(l.path, ".claude", "rules", "link.md"));
  const text = buildLocationRulesContext([l]);
  expect(text).not.toContain("OUTSIDE_MARK");
  expect(text).not.toContain("KEY_MARK");
  expect(text).toContain("### CLAUDE.md");
});

test("no rule file = no block; a long file is cut; a $HOME location is skipped", () => {
  expect(buildLocationRulesContext([repo({ "README.md": "x" })])).toBe("");
  const long = buildLocationRulesContext([repo({ "CLAUDE.md": "line\n".repeat(4000) })]);
  expect(long).toContain("chars cut from the middle of CLAUDE.md");
  expect(long.length).toBeLessThan(LOCATION_RULES_FILE_MAX + 1000);
  const home: Location = {
    name: "home",
    workspace: "main",
    path: homedir(),
    description: "",
    git: false,
  };
  expect(buildLocationRulesContext([home])).toBe("");
});

test("workers get the location rules block after the registry and before memory; the lead never", () => {
  const env = makeEnv();
  const base = { agentHome: env.home, workspace: "main", locationRules: "RULES_MARK" };
  const worker = buildPromptContext({ ...base, kind: "worker", registry: "REGISTRY_MARK" });
  expect(worker.slice(0, 2)).toEqual(["REGISTRY_MARK", "RULES_MARK"]);
  expect(buildPromptContext({ ...base, kind: "lead" }).join("\n")).not.toContain("RULES_MARK");
});
