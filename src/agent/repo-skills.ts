import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Skill names found under `<dir>/.claude/skills/<name>/SKILL.md` for the given dirs.
 * Passed to the SDK `skills` option so only the repos' own skills are listed to the model
 * (the SDK would otherwise add its ~18 bundled skills to every prompt).
 */
export function listRepoSkills(dirs: string[]): string[] {
  const names = new Set<string>();
  for (const dir of dirs) {
    const root = join(dir, ".claude", "skills");
    try {
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if ((e.isDirectory() || e.isSymbolicLink()) && existsSync(join(root, e.name, "SKILL.md"))) {
          names.add(e.name);
        }
      }
    } catch {
      /* no skills dir */
    }
  }
  return [...names];
}
