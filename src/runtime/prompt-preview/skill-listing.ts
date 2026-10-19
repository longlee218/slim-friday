import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_LOCK_FILE } from "../../config/skills-lock";
import { workspacePaths } from "../../config/workspace-paths";
import type { RoleDefinition } from "../../roles/role-types";
import { installedPublisherPlugins, PUBLISHER_SKILLS_DIR } from "../skills-plugin/publisher-skills";

/** One skill the run lists (the Skill tool loads it by its qualified name). */
export interface ListedSkill {
  /** `<plugin>:<skill>`, the name the run lists. */
  name: string;
  description: string;
}

/** `description:` of the frontmatter block of a SKILL.md; "" when missing or unreadable. */
function description(skillFile: string): string {
  try {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skillFile, "utf8"))?.[1];
    const d = fm ? (Bun.YAML.parse(fm) as { description?: unknown }).description : undefined;
    return typeof d === "string" ? d.trim() : "";
  } catch {
    return "";
  }
}

/**
 * The skills a run of `role` lists, read from the same sources the runtime copies from: the installed publisher
 * skills narrowed to `role.skills` (`.agents/skills` + the lock), then the workspace's own dir. No plugin is built.
 */
export function listedSkills(
  role: RoleDefinition,
  agentHome: string,
  workspace: string | undefined,
): ListedSkill[] {
  const wanted = role.skills ?? [];
  const out: ListedSkill[] = [];
  for (const { plugin, skills } of installedPublisherPlugins(
    PUBLISHER_SKILLS_DIR,
    SKILLS_LOCK_FILE,
  ))
    for (const s of skills.filter((n) => wanted.includes(n)))
      out.push({
        name: `${plugin}:${s}`,
        description: description(join(PUBLISHER_SKILLS_DIR, s, "SKILL.md")),
      });
  const dir = workspace ? workspacePaths(agentHome).workspace(workspace).skills : undefined;
  if (workspace && dir && existsSync(dir))
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory())
        out.push({
          name: `${workspace}:${e.name}`,
          description: description(join(dir, e.name, "SKILL.md")),
        });
  return out;
}
