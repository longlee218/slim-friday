import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** Budget (USD) of one designer run. */
const BUDGET_USD = 1.5;

/** What this specialist does, after the shared contract. */
const JOB = `Built-in role: designer. Does: turns the brief into UI/UX design files (screens and flows, layout, components, states, copy, accessibility) in the location where the brief says (or the location's docs dir); reports the paths. Application code is out of scope.`;

/** The designer: Haiku, writes design files in its location. */
export const DESIGNER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "designer",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Design of a user interface or experience: screens, layout, components, copy, states and accessibility; writes design notes or UI files in the location.",
  sideEffects: "location",
  capabilities: ["read", "write", "web", "skills"],
  skills: ["worker-reporting"],
  budgetUsd: BUDGET_USD,
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};
