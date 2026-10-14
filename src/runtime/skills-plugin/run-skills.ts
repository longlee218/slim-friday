import { SKILLS_LOCK_FILE } from "../../config/skills-lock";
import { workspacePaths } from "../../config/workspace-paths";
import type { RoleSkills } from "../../roles/role-types";
import { readWorkspaceSkills } from "../skills-config";
import { buildSkillsPlugin, mergeRunSkills, NO_SKILLS, type RunSkills } from "./plugin-builder";
import {
  installedPublisherPlugins,
  PUBLISHER_CAPS,
  PUBLISHER_SKILLS_DIR,
} from "./publisher-skills";

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
  /** Publisher skills of the run's role (`RoleDefinition.skills`): `none` = the workspace dir only. */
  skills: RoleSkills;
  /** Publisher skills dir and its lock (test seams); default to the app's `.agents/skills` and `skills-lock.json`. */
  publisherDir?: string;
  lockFile?: string;
}

/**
 * Skills option of a run, the ONLY source of skills (settingSources is always [] and location `.claude/skills` is never
 * read): for a role with `skills: "all"`, one plugin per installed publisher (`<plugin>:<name>`, from the skills lock
 * and the dirs on disk: no skill name lives in code), plus the workspace's own dir (when workspace.yaml `skills.extra`,
 * default true; `<ws>:<name>`). `skills` lists exactly the loadable qualified names, so the SDK's bundled skills stay
 * hidden. Every skill is COPIED whole: a skill's scripts may reach into a sibling's dir.
 */
export function buildRunSkills(i: RunSkillsInput): RunSkills {
  if (!i.workspace) return NO_SKILLS;
  const cfg = readWorkspaceSkills(i.agentHome, i.workspace);
  const parts: RunSkills[] = [];
  try {
    if (i.skills === "all") {
      const srcDir = i.publisherDir ?? PUBLISHER_SKILLS_DIR;
      for (const { plugin, skills } of installedPublisherPlugins(
        srcDir,
        i.lockFile ?? SKILLS_LOCK_FILE,
      ))
        parts.push(
          buildSkillsPlugin(
            { name: plugin, kind: "publisher", srcDir, allow: skills, caps: PUBLISHER_CAPS },
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
