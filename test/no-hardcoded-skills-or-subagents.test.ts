import { expect, test } from "bun:test";
import { join } from "node:path";
import { readSkillsLock } from "../src/config/skills-lock";

// No skill, plugin or subagent name may appear in src/ (code, comments, prompt strings): installing a skill or
// adding a subagent must never need a code change. The banned set is computed from skills-lock.json (every skill
// dir name and every plugin name = last segment of an entry `source`), so a new install is covered by itself, plus
// the app subagent names that were removed and the SDK's built-in one. Whole-word match. The one exception is role
// DATA: a role file `roles/builtin/<name>-role.ts` lists its own publisher skills (`skills: [...]`), which is a data
// edit, not a code change.

const SRC = join(import.meta.dir, "..", "src");

// The `friday` source holds the app's own role skills (scout, plan-work, ...): role names in code, not installs.
const lock = Object.fromEntries(
  Object.entries(readSkillsLock()).filter(([, e]) => !e.source.endsWith("/friday")),
);
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
/** Role data files: the place where a role names the skills it gets. */
const ROLE_DATA = /^roles\/builtin\/[a-z-]+-role\.ts$/;
const MATCHERS = [...BANNED].map((n) => [n, re(n)] as const);

/** The one exempt text of a role file: its `skills: [...]` array literal (role data), blanked before the scan. */
const stripSkillsList = (text: string): string =>
  text.replace(/\bskills:\s*\[[^\]]*\]/g, (m) => m.replace(/[^\n]/g, " "));

/** Banned-name hits of one file's text (line numbers kept); a role data file loses only its `skills` list. */
function scan(rel: string, text: string): string[] {
  const body = ROLE_DATA.test(rel) ? stripSkillsList(text) : text;
  const hits: string[] = [];
  body.split("\n").forEach((line, i) => {
    for (const [name, m] of MATCHERS)
      if (m.test(line)) hits.push(`src/${rel}:${i + 1}: [${name}] ${line.trim()}`);
  });
  return hits;
}

test("the lock yields a non-empty banned set (the scan cannot pass vacuously)", () => {
  expect(BANNED.size).toBeGreaterThan(10);
  expect(BANNED.has("superpowers")).toBe(true);
});

test("no skill, plugin or subagent name in src/", async () => {
  const hits: string[] = [];
  for await (const rel of new Bun.Glob("**/*.ts").scan(SRC)) {
    hits.push(...scan(rel, await Bun.file(join(SRC, rel)).text()));
  }
  expect(hits).toEqual([]);
});

test("a role file may name skills only inside `skills: [...]`; a banned name anywhere else still fails", () => {
  const role = "roles/builtin/x-role.ts";
  const name = "superpowers";
  expect(scan(role, `export const R = {\n  skills: ["${name}"],\n  other: [],\n};`)).toEqual([]);
  expect(scan(role, `skills: [\n  "${name}",\n],\n`)).toEqual([]);
  expect(scan(role, `skills: ["a"],\nconst CONTRACT = "use ${name}";`)).toHaveLength(1);
  expect(scan(role, `// ${name}\nskills: []`)).toHaveLength(1);
  expect(scan("other/y.ts", `skills: ["${name}"]`)).toHaveLength(1);
});
