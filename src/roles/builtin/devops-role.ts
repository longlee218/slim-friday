import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** What this specialist does, after the shared contract. */
const JOB = `Built-in role: devops. Does: creates or fixes build and infrastructure files (Dockerfile, CI workflow, scripts, config) in the location and checks them locally with the sandboxed shell (build, lint, dry run). Has no credentials and no deploy tool; the network is open, so a cloud or registry call is out of scope, not blocked. Never writes a secret into a file. Reports the files changed and what each check showed.`;

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
    "ci-cd-and-automation",
    "observability-and-instrumentation",
    "docker-build-strategies",
    "docker-destructive-guardrails",
  ],
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};
