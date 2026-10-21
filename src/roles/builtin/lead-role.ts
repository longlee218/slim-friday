import { SONNET_MODEL } from "../../config/model-ids";
import { ARTIFACT_TOOLS } from "../../mcp/artifacts/artifact-tool-names";
import { MEMORY_EDIT_TOOL } from "../../mcp/memory/tools/MemoryEditTool/constants";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SAVE_TOOL } from "../../mcp/memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { ORCHESTRATE_TOOL } from "../../mcp/orchestration/tools/OrchestrateTool/constants";
import { leadContract } from "../prompts/contracts/lead-contract";
import type { RoleDefinition } from "../role-types";

/** The lead's method skill: its folder name in `.agents/skills` (data) and the qualified name the Skill tool takes (`friday:<name>`). */
const LEAD_SKILL = "lead-orchestration";
const LEAD_SKILL_REF = `friday:${LEAD_SKILL}`;

/** The lead asks the owner through its own `Orchestrate ask_owner` action, never AskUserQuestion. */
const MAX_ASK = 0;
/** Budget (USD) of one lead run (a short routing turn). There is no daily lead budget. */
const BUDGET_USD = 1.5;
/** Agent loops (SDK turns) one lead run may take. */
const MAX_TURNS = 30;

/**
 * The lead: Sonnet. Chosen by the lead runner (not by `entryRole`), reached only through it (`kind: "lead"`), so intent
 * routing never offers it. Its tools are the `orchestration` server's lead tools (typed actions; handlers hold the rules).
 */
export const LEAD_ROLE: RoleDefinition = {
  name: "lead",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse: "Routes the owner's messages to specialist workers and reports their results.",
  kind: "lead",
  skills: [LEAD_SKILL, "brainstorming"], // the app-owned method skill + the owner dialogue skill (only the lead talks to the human); needs the `skills` capability for the Skill tool (its references)
  preloadSkills: [LEAD_SKILL], // its text is in the system prompt: the lead never has to remember to load it
  // Memory tools + the lead's `Orchestrate` action tool (the `orchestration` server; a worker run never gets it).
  mcpTools: [
    MEMORY_SAVE_TOOL,
    MEMORY_EDIT_TOOL,
    MEMORY_SEARCH_TOOL,
    MEMORY_GET_TOOL,
    MEMORY_EXPAND_TOOL,
    ...ARTIFACT_TOOLS,
    ORCHESTRATE_TOOL,
  ],
  limits: { maxAsk: MAX_ASK, maxTurns: MAX_TURNS },
  subagents: { parallel: 3, depth: 1 },
  sideEffects: "none",
  capabilities: ["read", "skills"],
  noSubagents: true, // the lead dispatches through its tools only
  permissionMode: "auto",
  model: SONNET_MODEL,
  thinking: { type: "adaptive" }, // the model decides how long to think (a short routing turn)
  budgetUsd: BUDGET_USD,
  promptSections: () => [leadContract(LEAD_SKILL_REF)],
};
