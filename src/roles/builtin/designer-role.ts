import { OPUS_MODEL } from "../../config/model-ids";
import { PLAYWRIGHT_TOOLS } from "../../mcp/playwright/playwright-tool-names";
import { designerContract } from "../prompts/contracts/designer-contract";
import type { RoleDefinition } from "../role-types";
import { METHOD_SKILL, SPECIALIST_BASE } from "./specialist-contract";

/** The designer: Opus, coding preset (writes prototypes, design components and tokens as files); a sandboxed shell runs its design tools (owner 2026-10-20). */
export const DESIGNER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools, ...PLAYWRIGHT_TOOLS],
  name: "designer",
  whenToUse:
    "Design of a user interface or experience: screens, layout, components, copy, states and accessibility; writes design notes or static mockups in the location and runs design tools (sandboxed shell).",
  sideEffects: "location",
  capabilities: ["read", "write", "shell", "web", "skills"],
  skills: [
    METHOD_SKILL,
    "worker-reporting",
    "verification-before-completion",
    "docs-seeker",
    "ui-ux-pro-max",
    "wcag-audit-patterns",
    "impeccable",
  ],
  model: OPUS_MODEL,
  preloadSkills: [METHOD_SKILL], // the rule to check skills first is in the system prompt
  requiredSkills: ["ui-ux-pro-max", "impeccable"], // called before the first edit or command (named in one prompt line)
  binaries: ["impeccable-engine"], // a design skill's engine, pinned by sha256 (config/data/pinned-binaries.yaml)
  promptSections: () => designerContract(),
};
