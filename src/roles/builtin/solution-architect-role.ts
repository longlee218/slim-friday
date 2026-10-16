import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** Budget (USD) of one solution-architect run. */
const BUDGET_USD = 0.5;

/** What this specialist does, after the shared contract. */
const JOB = `You are the solution architect. Read the relevant code and docs, then give a design the next workers can build from: the chosen approach and why, the alternatives you rejected, components and interfaces, data shape, risks and open questions. Be concrete (paths, names) and short. You change no files: your design is your report.`;

/** The solution architect: Haiku, read and web tools, no side effects. */
export const SOLUTION_ARCHITECT_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "solution-architect",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Design before building: compare approaches, choose one, define components, interfaces, data and risks for a feature or system; reads code and docs, writes no files.",
  sideEffects: "none",
  capabilities: ["read", "web", "skills"],
  skills: ["brainstorming"],
  budgetUsd: BUDGET_USD,
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};
