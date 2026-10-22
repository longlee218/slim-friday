import { devopsContract } from "../prompts/contracts/devops-contract";
import type { RoleDefinition } from "../role-types";
import { METHOD_SKILL, SPECIALIST_BASE, TEAM_SKILL } from "./specialist-contract";

/** The devops engineer: Sonnet, writes infra files and checks them locally. */
export const DEVOPS_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "devops",
  whenToUse:
    "Build and infrastructure files: Dockerfile, CI workflows, scripts, config; checks them locally (build, lint, dry run). Has no credentials or deploy tool.",
  notFor: "Deploys; anything that needs credentials.",
  sideEffects: "location",
  capabilities: ["read", "write", "shell", "skills"],
  skills: [
    METHOD_SKILL,
    TEAM_SKILL,
    "worker-reporting",
    "verification-before-completion",
    "systematic-debugging",
    "devops-engineer",
    "kubernetes-specialist",
  ],
  preloadSkills: [METHOD_SKILL, TEAM_SKILL], // the rule to check skills first is in the system prompt
  requiredSkills: ["verification-before-completion", "devops-engineer"], // called before the first edit or command (named in one prompt line)
  promptSections: () => devopsContract(),
};
