import { join } from "node:path";
import type { RoleSkill } from "../../roles/role-types";
import type { PluginCaps } from "./plugin-copy";

/**
 * Where the publisher's skills live: `<app root>/.agents/skills/<name>/` (a flat dir of skill folders, pinned by the
 * repo-root `skills-lock.json`). They are loaded whole and unmodified: Friday never patches a skill text.
 */
export const PUBLISHER_SKILLS_DIR = join(import.meta.dir, "../../../.agents/skills");

/** Caps of the publisher plugin: per skill 100 entries / 1 MB, whole plugin 300 entries / 5 MB (one file: 1 MB, see plugin-copy). */
export const PUBLISHER_CAPS: PluginCaps = {
  skill: { files: 100, bytes: 1024 * 1024 },
  total: { files: 300, bytes: 5 * 1024 * 1024 },
};

/**
 * Dir names of the skills a stage may LOAD: every skill of the role whose `needs` are all in the stage's subagent
 * list (`StageDefinition.subagents`). One list controls agents AND skills, so a skill that dispatches a subagent the
 * stage cannot start never shows up.
 */
export function allowedSkills(
  skills: readonly RoleSkill[],
  stageSubagents: readonly string[],
): string[] {
  return skills
    .filter((s) => (s.needs ?? []).every((agent) => stageSubagents.includes(agent)))
    .map((s) => s.name);
}
