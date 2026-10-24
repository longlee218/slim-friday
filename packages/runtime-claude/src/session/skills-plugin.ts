import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Name of the generated plugin: the SDK lists its skills as `friday:<skill>`. */
export const SKILLS_PLUGIN = "friday";

/** A skill name is one plain path part (it becomes a dir name). */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Build the skills plugin of one bot under `<scratchDir>/skills-plugin/`: a local SDK plugin that holds a copy of
 * only the skills the bot lists. Each skill is the first `<dir>/<name>/SKILL.md` found in `skillDirs` (the owner's dir
 * before the shipped one). The dir is rebuilt on every call, so a skill removed from the bot's list is gone from the
 * next session. Throws, naming it, for a skill that is not a plain name or is not found.
 */
export function buildSkillsPlugin(
  scratchDir: string,
  skillDirs: string[],
  names: string[],
): { path: string; skills: string[] } {
  const bad = names.find((n) => !SKILL_NAME.test(n));
  if (bad !== undefined) throw new Error(`skill name is not a plain name: "${bad}"`);
  const sources = names.map((n) => {
    const dir = skillDirs.map((d) => join(d, n)).find((d) => existsSync(join(d, "SKILL.md")));
    if (!dir) throw new Error(`skill not found: ${n}`);
    return { name: n, dir };
  });
  const path = join(scratchDir, "skills-plugin");
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(path, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: SKILLS_PLUGIN, description: "Skills of this bot", version: "1.0.0" }),
  );
  for (const s of sources) cpSync(s.dir, join(path, "skills", s.name), { recursive: true });
  return { path, skills: names.map((n) => `${SKILLS_PLUGIN}:${n}`) };
}
