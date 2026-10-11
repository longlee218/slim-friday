import { join } from "node:path";
import { workspacePaths } from "../../config/workspace-paths";
import { readWorkspaceSkills } from "../skills-config";
import { buildSkillsPlugin, mergeRunSkills, NO_SKILLS, type RunSkills } from "./plugin-builder";
import { allowedSkills, SET_CAPS, SKILL_SETS_DIR, setFileFilter } from "./skill-sets";

/** Caps of the owner-curated workspace dir: per skill 100 entries / 2 MB, whole dir 300 entries / 5 MB. */
export const WORKSPACE_CAPS = {
  skill: { files: 100, bytes: 2 * 1024 * 1024 },
  total: { files: 300, bytes: 5 * 1024 * 1024 },
};

/** Inputs of the skills of one run. */
export interface RunSkillsInput {
  agentHome: string;
  /** Workspace of the run; none = no skills at all. */
  workspace: string | undefined;
  /** Skill sets of the run's role (`RoleDefinition.skillSets`); none = the workspace dir only. */
  sets: string[];
}

/**
 * Skills option of a run, the ONLY source of skills (settingSources is always [] and repo `.claude/skills` is never
 * read): one plugin per skill set the run's role names, plus the workspace's own dir (when workspace.yaml
 * `skills.extra`, default true). `skills` lists exactly the qualified names (`superpowers:<name>`, `<ws>:<name>`),
 * so the SDK's bundled skills stay hidden. A role with no sets gets the workspace-only plugin, as before sets existed.
 */
export function buildRunSkills(i: RunSkillsInput): RunSkills {
  if (!i.workspace) return NO_SKILLS;
  const cfg = readWorkspaceSkills(i.agentHome, i.workspace);
  const parts: RunSkills[] = [];
  try {
    for (const set of i.sets) {
      const allow = allowedSkills(set);
      if (!allow.length) continue;
      parts.push(
        buildSkillsPlugin(
          {
            name: set,
            kind: "set",
            srcDir: join(SKILL_SETS_DIR, set, "skills"),
            allow,
            caps: SET_CAPS,
            filter: setFileFilter,
          },
          i.agentHome,
        ),
      );
    }
    if (cfg.extra) {
      const ws = workspacePaths(i.agentHome).workspace(i.workspace);
      parts.push(
        buildSkillsPlugin(
          {
            name: i.workspace,
            kind: "workspace",
            srcDir: ws.skills,
            caps: WORKSPACE_CAPS,
            trustRoot: ws.root,
          },
          i.agentHome,
        ),
      );
    }
  } catch (err) {
    // buildSkillsPlugin never throws; a bug elsewhere must not leak the dirs already built.
    mergeRunSkills(parts).cleanup();
    throw err;
  }
  return mergeRunSkills(parts);
}
