import { hackerContract } from "../prompts/contracts/hacker-contract";
import type { RoleDefinition } from "../role-types";
import { METHOD_SKILL, SPECIALIST_BASE, TEAM_SKILL } from "./specialist-contract";

/** The hacker: Sonnet, read-only defensive review. */
export const HACKER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "hacker",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Defensive security review of code in a location: vulnerabilities, unsafe patterns, secrets in code, risky dependencies; reports findings with severity.",
  notFor: "Fixing the findings.",
  sideEffects: "none",
  capabilities: ["read", "shell", "skills"],
  skills: [
    METHOD_SKILL,
    TEAM_SKILL,
    "worker-reporting",
    "systematic-debugging",
    "verification-before-completion",
    "security-and-hardening",
  ],
  preloadSkills: [METHOD_SKILL, TEAM_SKILL], // the rule to check skills first is in the system prompt
  requiredSkills: ["security-and-hardening", "verification-before-completion"], // called before the first edit or command (named in one prompt line)
  promptSections: () => hackerContract(),
};
