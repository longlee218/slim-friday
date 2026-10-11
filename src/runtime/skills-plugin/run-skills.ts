import { existsSync } from "node:fs";
import { join } from "node:path";
import { PUBLISHER_PLUGIN, workspacePaths } from "../../config/workspace-paths";
import type { RoleSkill } from "../../roles/role-types";
import { readWorkspaceSkills } from "../skills-config";
import { buildSkillsPlugin, mergeRunSkills, NO_SKILLS, type RunSkills } from "./plugin-builder";
import { log } from "./plugin-copy";
import { allowedSkills, PUBLISHER_CAPS, PUBLISHER_SKILLS_DIR } from "./publisher-skills";

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
  /** Publisher skills of the run's role (`RoleDefinition.skills`); none = the workspace dir only. */
  skills: readonly RoleSkill[];
  /** Subagent names the stage may start: a skill that needs one the stage lacks is not loaded. */
  subagents: readonly string[];
  /** Publisher skills dir (test seam); defaults to the app's `.agents/skills`. */
  publisherDir?: string;
}

/**
 * Skills option of a run, the ONLY source of skills (settingSources is always [] and repo `.claude/skills` is never
 * read): one plugin of the publisher skills the run's role lists (`superpowers:<name>`) plus the workspace's own dir
 * (when workspace.yaml `skills.extra`, default true; `<ws>:<name>`). `skills` lists exactly the loadable qualified
 * names, so the SDK's bundled skills stay hidden. Every skill of the role is COPIED (whole), only the allowed ones are
 * listed: a listed skill's scripts may reach into a gated sibling's dir.
 */
export function buildRunSkills(i: RunSkillsInput): RunSkills {
  if (!i.workspace) return NO_SKILLS;
  const cfg = readWorkspaceSkills(i.agentHome, i.workspace);
  const parts: RunSkills[] = [];
  try {
    const expose = allowedSkills(i.skills, i.subagents);
    if (expose.length) {
      const srcDir = i.publisherDir ?? PUBLISHER_SKILLS_DIR;
      const allow = i.skills.map((s) => s.name);
      for (const name of allow.filter((n) => !existsSync(join(srcDir, n, "SKILL.md"))))
        log.warn(
          { skill: `${PUBLISHER_PLUGIN}:${name}` },
          "role lists a skill that is not on disk",
        );
      parts.push(
        buildSkillsPlugin(
          {
            name: PUBLISHER_PLUGIN,
            kind: "publisher",
            srcDir,
            allow,
            expose,
            caps: PUBLISHER_CAPS,
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
