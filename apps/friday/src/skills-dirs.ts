import { join } from "node:path";

/** Skills shipped with the repo (`.agents/skills/<name>/SKILL.md`, pinned by `skills-lock.json`). */
export const SHIPPED_SKILLS_DIR = join(import.meta.dir, "..", "..", "..", ".agents", "skills");

/** Where a bot's skills are looked up: the owner's `<AGENT_HOME>/config/skills` first, then the shipped ones. */
export const skillDirs = (agentHome: string): string[] => [
  join(agentHome, "config", "skills"),
  SHIPPED_SKILLS_DIR,
];
