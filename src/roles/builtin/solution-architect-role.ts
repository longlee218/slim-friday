import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** What this specialist does, after the shared contract. */
const JOB = `Built-in role: solution architect. Does: reads the relevant code and docs and reports a design the next workers can build from: approach and reason, rejected alternatives, components and interfaces, data shape, risks, open questions. Changes no files; the report is the design.`;

/** The solution architect: Sonnet, read and web tools, no side effects. */
export const SOLUTION_ARCHITECT_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "solution-architect",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Design before building: compare approaches, choose one, define components, interfaces, data and risks for a feature or system; reads code and docs, writes no files.",
  sideEffects: "none",
  capabilities: ["read", "web", "skills"],
  skills: ["worker-reporting", "brainstorming", "architecture-designer", "docs-seeker"],
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};
