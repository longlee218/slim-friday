import { designerContract } from "../prompts/contracts/designer-contract";
import type { RoleDefinition } from "../role-types";
import {
  SPECIALIST_BASE,
  SPECIALIST_BUDGET_USD,
  SPECIALIST_MAX_TURNS,
} from "./specialist-contract";

/** The designer: Sonnet, writes design files in its location. */
export const DESIGNER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "designer",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Design of a user interface or experience: screens, layout, components, copy, states and accessibility; writes design notes or UI files in the location.",
  sideEffects: "location",
  capabilities: ["read", "write", "web", "skills"],
  skills: [
    "worker-reporting",
    "brainstorming",
    "verification-before-completion",
    "docs-seeker",
    "frontend-ui-engineering",
    "frontend-design",
    "wcag-audit-patterns",
  ],
  promptSections: () => designerContract(),
};
