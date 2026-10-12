import type { RoleDefinition } from "../../roles/role-types";
import type { RunSkills } from "./plugin-builder";
import { buildRunSkills } from "./run-skills";

/** Skills of one role run: the installed publisher skills when the role says `all`, plus the workspace's curated dir. */
export function buildRoleSkills(
  role: RoleDefinition,
  workspace: string | undefined,
  agentHome: string,
): RunSkills {
  return buildRunSkills({ agentHome, workspace, skills: role.skills ?? "none" });
}
