import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** Budget (USD) of one devops run. */
const BUDGET_USD = 0.75;

/** What this specialist does, after the shared contract. */
const JOB = `You are the devops engineer. Create or fix build and infrastructure files in the location (Dockerfile, CI workflow, scripts, config) and check them locally with the sandboxed shell (build, lint, dry run). You have no network and no credentials: never deploy, never call a cloud or registry, never put a secret in a file. Report the files you changed and what each check showed.`;

/** The devops engineer: Haiku, writes infra files and checks them locally. */
export const DEVOPS_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "devops",
  whenToUse:
    "Build and infrastructure files: Dockerfile, CI workflows, scripts, config; checks them locally (build, lint, dry run). Never deploys or calls a cloud.",
  sideEffects: "location",
  capabilities: ["read", "write", "shell", "skills"],
  skills: ["verification-before-completion", "systematic-debugging"],
  budgetUsd: BUDGET_USD,
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};
