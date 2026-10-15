import type { RoleDefinition } from "../../roles/role-types";
import { buildAppSkills } from "./app-skills";
import { mergeRunSkills, type RunSkills } from "./plugin-builder";
import { buildRunSkills } from "./run-skills";

/**
 * Skills of one role run: the installed publisher skills when the role says `all`, plus the workspace's curated dir,
 * plus the app-owned skills the role lists (`appSkills`; they need no workspace).
 */
export function buildRoleSkills(
  role: RoleDefinition,
  workspace: string | undefined,
  agentHome: string,
): RunSkills {
  return mergeRunSkills([
    buildRunSkills({ agentHome, workspace, skills: role.skills ?? "none" }),
    buildAppSkills(role.appSkills, agentHome),
  ]);
}
