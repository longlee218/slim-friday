import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSkillsLock } from "../../config/skills-lock";
import { demoteHeadings } from "../../text/demote-headings";
import { PUBLISHER_SKILLS_DIR } from "./publisher-skills";

/**
 * The text of the skills a role preloads (`RoleDefinition.preloadSkills`): each installed skill's SKILL.md without its
 * frontmatter, under a heading with its own headings pushed two levels down, so the method is in the system prompt and does not depend on a Skill tool call. A name
 * that is not in the lock or has no SKILL.md is left out (the same rule as the skills a run loads). Read per run, so an
 * edited skill shows up without a code change.
 */
export function preloadedSkillsText(
  names: readonly string[] | undefined,
  srcDir: string = PUBLISHER_SKILLS_DIR,
): string {
  if (!names?.length) return "";
  const installed = readSkillsLock();
  const parts: string[] = [];
  for (const name of names) {
    const file = join(srcDir, name, "SKILL.md");
    if (!(name in installed) || !existsSync(file)) continue;
    // Frontmatter = a leading `---` block; the description there is the Skill tool's listing text, not method.
    const body = readFileSync(file, "utf8")
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      .trim();
    parts.push(`## Skill ${name} (method, always loaded)\n${demoteHeadings(body, 2)}`);
  }
  return parts.join("\n\n");
}
