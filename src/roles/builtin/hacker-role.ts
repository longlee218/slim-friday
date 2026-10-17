import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** Budget (USD) of one hacker run. */
const BUDGET_USD = 1.5;

/** What this specialist does, after the shared contract. */
const JOB = `You are the security reviewer (defensive only). Review the code in the location for vulnerabilities (injection, auth, path handling, unsafe deserialisation, secrets in code, risky dependencies) with read tools and the sandboxed shell (no network, no write). Report findings ranked by severity, each with path:line, why it is exploitable and a fix hint; say plainly when you found nothing. Never test a system outside the location.`;

/** The hacker: Haiku, read-only defensive review. */
export const HACKER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "hacker",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Defensive security review of code in a location: vulnerabilities, unsafe patterns, secrets in code, risky dependencies; read-only, reports findings with severity.",
  sideEffects: "none",
  capabilities: ["read", "shell", "skills"],
  skills: ["systematic-debugging"],
  budgetUsd: BUDGET_USD,
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};
