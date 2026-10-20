import { pluginNameOf, readSkillsLock } from "../../config/skills-lock";

/**
 * The one fact line of a role's required skills (`RoleDefinition.requiredSkills`), built from data: each installed skill
 * under the qualified name the Skill tool takes (`<plugin>:<name>`, the plugin from the skills lock). A name that is not
 * in the lock is left out (the same rule as the skills a run loads). Empty when nothing is required.
 */
export function requiredSkillsText(names: readonly string[] | undefined): string {
  if (!names?.length) return "";
  const installed = readSkillsLock();
  const qualified = names.flatMap((n) => {
    const entry = installed[n];
    return entry ? [`${pluginNameOf(entry.source)}:${n}`] : [];
  });
  if (!qualified.length) return "";
  return `Required skills for this role (call each with the Skill tool before you start): ${qualified.join(", ")}`;
}
