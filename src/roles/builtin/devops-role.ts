import { devopsContract } from "../prompts/contracts/devops-contract";
import type { RoleDefinition } from "../role-types";
import {
  SPECIALIST_BASE,
  SPECIALIST_BUDGET_USD,
  SPECIALIST_MAX_TURNS,
} from "./specialist-contract";

/** The devops engineer: Sonnet, writes infra files and checks them locally. */
export const DEVOPS_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "devops",
  whenToUse:
    "Build and infrastructure files: Dockerfile, CI workflows, scripts, config; checks them locally (build, lint, dry run). Has no credentials or deploy tool.",
  sideEffects: "location",
  capabilities: ["read", "write", "shell", "skills"],
  skills: [
    "worker-reporting",
    "verification-before-completion",
    "systematic-debugging",
    "devops-engineer",
    "kubernetes-specialist",
  ],
  promptSections: () => devopsContract(),
};
