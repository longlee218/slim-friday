import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { removeTree } from "../src/runtime/skills-plugin/plugin-copy";
import { buildRunSkills } from "../src/runtime/skills-plugin/run-skills";
import { readSkillsLock } from "./skills-lock-hash";

/* The `RoleSkills` list path: a role that names publisher skills gets exactly those; a name not installed is skipped. */

const homes: string[] = [];
afterAll(() => {
  for (const d of homes) removeTree(d);
});

/** A home whose workspace `main` has an empty own skills dir. */
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "rskill-"));
  homes.push(h);
  const ws = workspacePaths(h).workspace("main");
  mkdirSync(ws.skills, { recursive: true });
  writeFileSync(ws.config, "channels: []\n");
  return h;
}

const NAMES = Object.keys(readSkillsLock().skills);

test("a skills list loads only the listed publisher skills and skips unknown names", () => {
  const want = NAMES.slice(0, 2);
  const r = buildRunSkills({
    agentHome: home(),
    workspace: "main",
    skills: [...want, "no-such-skill"],
  });
  try {
    expect(r.skills.map((n) => n.split(":").at(-1)).sort()).toEqual([...want].sort());
  } finally {
    r.cleanup();
  }
});

test("a list of unknown names loads no publisher skill", () => {
  const r = buildRunSkills({ agentHome: home(), workspace: "main", skills: ["no-such-skill"] });
  try {
    expect(r.skills).toEqual([]);
  } finally {
    r.cleanup();
  }
});
