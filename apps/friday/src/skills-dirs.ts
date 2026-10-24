import { join } from "node:path";
import { DEFAULT_SKILLS_DIR } from "@friday/config";

/** Where a bot's skills are looked up: the owner's `<AGENT_HOME>/config/skills` first, then the shipped defaults. */
export const skillDirs = (agentHome: string): string[] => [
  join(agentHome, "config", "skills"),
  DEFAULT_SKILLS_DIR,
];
