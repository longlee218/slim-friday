import { join } from "node:path";
import { APP_SKILLS_PLUGIN } from "../../config/workspace-paths";
import { buildSkillsPlugin, NO_SKILLS, type RunSkills } from "./plugin-builder";
import { PUBLISHER_CAPS } from "./publisher-skills";

/** Where the app's own skills live: `src/roles/builtin/skills/<name>/SKILL.md`, shipped with the app (not a publisher's, not the owner's). */
export const APP_SKILLS_DIR = join(import.meta.dir, "../../roles/builtin/skills");

/**
 * The app-owned skills a role lists in its data (`RoleDefinition.appSkills`), as one plugin copy per run
 * (`<APP_SKILLS_PLUGIN>:<name>`), built like every other plugin (whole copy, caps, read-only, cleanup). Only the listed
 * names load, so a role never sees another role's skill. No names live in code: the role's data lists them.
 */
export function buildAppSkills(
  names: string[] | undefined,
  agentHome: string,
  srcDir = APP_SKILLS_DIR,
): RunSkills {
  if (!names?.length) return NO_SKILLS;
  return buildSkillsPlugin(
    { name: APP_SKILLS_PLUGIN, kind: "app", srcDir, allow: names, caps: PUBLISHER_CAPS },
    agentHome,
  );
}
