import { expect, test } from "bun:test";
import { join } from "node:path";
import { readSkillsLock } from "../src/config/skills-lock";

// No skill, plugin or subagent name may appear in src/ (code, comments, prompt strings): installing a skill or
// adding a subagent must never need a code change. The banned set is computed from skills-lock.json (every skill
// dir name and every plugin name = last segment of an entry `source`), so a new install is covered by itself, plus
// the app subagent names that were removed and the SDK's built-in one. Whole-word match, no allowlist.

const SRC = join(import.meta.dir, "..", "src");

/** Owner decision (2026-10-14): the dev role prompt names this one skill; no other file may. */
const ALLOWED_NAME = { name: "using-superpowers", file: "roles/builtin/dev-role.ts" };

const lock = readSkillsLock();
const BANNED = new Set<string>([
  ...Object.keys(lock),
  ...Object.values(lock).map((e) => e.source.split("/").pop() as string),
  "explorer",
  "implementer",
  "task-reviewer",
  "general-purpose",
]);

/** `-` is a name char: `using-superpowers` must not match as the word `superpowers` inside a longer slug. */
const re = (name: string) =>
  new RegExp(`(?<![A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`);
const MATCHERS = [...BANNED].map((n) => [n, re(n)] as const);

test("the lock yields a non-empty banned set (the scan cannot pass vacuously)", () => {
  expect(BANNED.size).toBeGreaterThan(10);
  expect(BANNED.has("superpowers")).toBe(true);
});

test("no skill, plugin or subagent name in src/", async () => {
  const hits: string[] = [];
  for await (const rel of new Bun.Glob("**/*.ts").scan(SRC)) {
    const lines = (await Bun.file(join(SRC, rel)).text()).split("\n");
    lines.forEach((line, i) => {
      for (const [name, m] of MATCHERS)
        if (m.test(line) && !(name === ALLOWED_NAME.name && rel === ALLOWED_NAME.file))
          hits.push(`src/${rel}:${i + 1}: [${name}] ${line.trim()}`);
    });
  }
  expect(hits).toEqual([]);
});
