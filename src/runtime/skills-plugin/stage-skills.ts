import { roleOfStage } from "../../roles/role-registry";
import type { StageDefinition } from "../../roles/role-types";
import type { RunSkills } from "./plugin-builder";
import { log } from "./plugin-copy";
import { buildRunSkills } from "./run-skills";

/**
 * Skills of one stage run: the sets of the stage's role (`RoleDefinition.skillSets`) plus the workspace dir. A stage
 * that resolves to no role (an object that is not the registry's) gets no set, with a warn: never silently.
 */
export function buildStageSkills(
  stage: StageDefinition,
  workspace: string | undefined,
  agentHome: string,
): RunSkills {
  const role = roleOfStage(stage);
  if (!role) log.warn({ stage: stage.name }, "stage has no role: no skill sets loaded");
  return buildRunSkills({
    agentHome,
    workspace,
    sets: role?.skillSets ?? [],
    subagents: stage.subagents ?? [],
  });
}
