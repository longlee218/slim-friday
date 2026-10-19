import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** Budget (USD) of one hacker run. */
const BUDGET_USD = 1.5;

/** What this specialist does, after the shared contract. */
const JOB = `Built-in role: security reviewer, defensive only. Does: reviews the location's code for vulnerabilities (injection, auth, path handling, unsafe deserialisation, secrets in code, risky dependencies) with read tools and the sandboxed shell (no write); reports findings ranked by severity with path:line, why it is exploitable and a fix hint, or says plainly that none were found. Out of scope: testing any system outside the location (the network is open, so this is a scope rule, not a block).`;

/** The hacker: Haiku, read-only defensive review. */
export const HACKER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "hacker",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Defensive security review of code in a location: vulnerabilities, unsafe patterns, secrets in code, risky dependencies; no write tools, reports findings with severity.",
  sideEffects: "none",
  capabilities: ["read", "shell", "skills"],
  skills: ["worker-reporting", "systematic-debugging"],
  budgetUsd: BUDGET_USD,
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};
