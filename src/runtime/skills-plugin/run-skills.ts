import { SKILLS_LOCK_FILE } from "../../config/skills-lock";
import { workspacePaths } from "../../config/workspace-paths";
import { logEvent, logger } from "../../observability/logger";
import type { RoleSkills } from "../../roles/role-types";
import { readWorkspaceSkills } from "../skills-config";
import { buildSkillsPlugin, mergeRunSkills, type RunSkills } from "./plugin-builder";
import {
  installedPublisherPlugins,
  PUBLISHER_CAPS,
  PUBLISHER_SKILLS_DIR,
} from "./publisher-skills";

/** Caps of the owner-curated workspace dir: per skill 100 entries / 2 MB, whole dir 300 entries / 5 MB. */
const WORKSPACE_CAPS = {
  skill: { files: 100, bytes: 2 * 1024 * 1024 },
  total: { files: 300, bytes: 5 * 1024 * 1024 },
};

/** Inputs of the skills of one run. */
export interface RunSkillsInput {
  agentHome: string;
  /** Workspace of the run; none = no workspace dir (the role's listed skills still load). */
  workspace: string | undefined;
  /** Publisher skills of the run's role (`RoleDefinition.skills`): `[]` = the workspace dir only. */
  skills: RoleSkills;
  /** Publisher skills dir and its lock (test seams); default to the app's `.agents/skills` and `skills-lock.json`. */
  publisherDir?: string;
  lockFile?: string;
}

/**
 * Skills option of a run, the ONLY source of skills (settingSources is always [] and location `.claude/skills` is never
 * read): one plugin per installed publisher (`<plugin>:<name>`, from the skills lock and the dirs on disk) narrowed to the
 * role's listed names (no skill name lives in code), plus the workspace's own dir (when workspace.yaml `skills.extra`,
 * default true; `<ws>:<name>`). `skills` lists exactly the loadable qualified names, so the SDK's bundled skills stay
 * hidden. Every skill is COPIED whole: a skill's scripts may reach into a sibling's dir.
 */
export function buildRunSkills(i: RunSkillsInput): RunSkills {
  // No workspace (the control channel): the role's listed skills still load, there is just no workspace dir.
  const cfg = i.workspace ? readWorkspaceSkills(i.agentHome, i.workspace) : undefined;
  const parts: RunSkills[] = [];
  try {
    const srcDir = i.publisherDir ?? PUBLISHER_SKILLS_DIR;
    const plugins = installedPublisherPlugins(srcDir, i.lockFile ?? SKILLS_LOCK_FILE);
    // A listed name that no installed plugin has (a skill the owner has not installed yet) is skipped, once per run, with a warning.
    const installed = new Set(plugins.flatMap((p) => p.skills));
    const unknown = i.skills.filter((n) => !installed.has(n));
    if (unknown.length)
      logEvent(logger, "skills.listed_not_installed", { skills: unknown }, "warn");
    for (const { plugin, skills } of plugins) {
      // A role's skill list narrows each plugin to the listed names; a plugin left with none is not built.
      const allow = skills.filter((n) => i.skills.includes(n));
      if (allow.length)
        parts.push(
          buildSkillsPlugin(
            { name: plugin, kind: "publisher", srcDir, allow, caps: PUBLISHER_CAPS },
            i.agentHome,
          ),
        );
    }
    if (i.workspace && cfg?.extra) {
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
