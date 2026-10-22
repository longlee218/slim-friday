import { solutionArchitectContract } from "../prompts/contracts/solution-architect-contract";
import type { RoleDefinition } from "../role-types";
import { METHOD_SKILL, SPECIALIST_BASE, TEAM_SKILL } from "./specialist-contract";

/** The solution architect: Sonnet, read and web tools, no side effects. */
export const SOLUTION_ARCHITECT_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "solution-architect",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Design before building: compare approaches and choose one; define components, interfaces, data and risks of a feature or system. Reads code and docs, writes no files.",
  notFor: "Fact lookups; screen and UI design.",
  sideEffects: "none",
  capabilities: ["read", "web", "skills"],
  skills: [METHOD_SKILL, TEAM_SKILL, "worker-reporting", "architecture-designer", "docs-seeker"],
  preloadSkills: [METHOD_SKILL, TEAM_SKILL], // the rule to check skills first is in the system prompt
  requiredSkills: ["architecture-designer"], // called before the first edit or command (named in one prompt line)
  promptSections: () => solutionArchitectContract(),
};
