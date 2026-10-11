import { roleOfStage } from "../../roles/role-registry";
import type { StageDefinition } from "../../roles/role-types";
import type { RunSkills } from "./plugin-builder";
import { log } from "./plugin-copy";
import { buildRunSkills } from "./run-skills";

/**
 * Skills of one stage run: the publisher skills of the stage's role (`RoleDefinition.skills`) plus the workspace dir. A stage
 * that resolves to no role (an object that is not the registry's) gets none, with a warn: never silently.
 */
export function buildStageSkills(
  stage: StageDefinition,
  workspace: string | undefined,
  agentHome: string,
): RunSkills {
  const role = roleOfStage(stage);
  if (!role) log.warn({ stage: stage.name }, "stage has no role: no publisher skills loaded");
  return buildRunSkills({
    agentHome,
    workspace,
    skills: role?.skills ?? [],
    subagents: stage.subagents ?? [],
  });
}
