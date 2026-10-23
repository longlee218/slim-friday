import { SONNET_MODEL } from "../../config/model-ids";
import { ARTIFACT_TOOLS } from "../../mcp/artifacts/artifact-tool-names";
import { MEMORY_EDIT_TOOL } from "../../mcp/memory/tools/MemoryEditTool/constants";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SAVE_TOOL } from "../../mcp/memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { ORCHESTRATE_TOOL } from "../../mcp/orchestration/tools/OrchestrateTool/constants";
import { TASK_BOARD_TOOL } from "../../mcp/orchestration/tools/TaskBoardTool/constants";
import { chiefOfStaffContract } from "../prompts/contracts/chief-of-staff-contract";
import type { RoleDefinition } from "../role-types";

/** The teammate's method skill: its folder name in `.agents/skills` (data) and the qualified name the Skill tool takes (`friday:<name>`). */
const TEAMMATE_SKILL = "teammate-orchestration";
const TEAMMATE_SKILL_REF = `friday:${TEAMMATE_SKILL}`;

/** The teammate asks the owner through its own `Orchestrate ask_owner` action, never AskUserQuestion. */
const MAX_ASK = 0;
/** Budget (USD) of an announce teammate run (a short routing turn); an owner-message run gets more (`TEAMMATE_OWNER_RUN_BUDGET_USD`). There is no daily teammate budget. */
const BUDGET_USD = 1.5;
/** Agent loops (SDK turns) an announce teammate run may take (`TEAMMATE_OWNER_RUN_MAX_TURNS` for an owner message). */
const MAX_TURNS = 30;

/**
 * The teammate: Sonnet. Chosen by the teammate runner (not by `entryRole`), reached only through it (`kind: "teammate"`), so intent
 * routing never offers it. Its tools are the `orchestration` server's teammate tools (typed actions; handlers hold the rules).
 */
export const CHIEF_OF_STAFF_ROLE: RoleDefinition = {
  name: "chief-of-staff",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse: "Routes the owner's messages to specialist workers and reports their results.",
  kind: "teammate",
  skills: [TEAMMATE_SKILL, "brainstorming"], // the app-owned method skill + the owner dialogue skill (only the teammate talks to the human); needs the `skills` capability for the Skill tool (its references)
  preloadSkills: [TEAMMATE_SKILL], // its text is in the system prompt: the teammate never has to remember to load it
  // Memory tools + the teammate's `Orchestrate` action tool (the `orchestration` server; a worker run never gets it).
  mcpTools: [
    MEMORY_SAVE_TOOL,
    MEMORY_EDIT_TOOL,
    MEMORY_SEARCH_TOOL,
    MEMORY_GET_TOOL,
    MEMORY_EXPAND_TOOL,
    ...ARTIFACT_TOOLS,
    ORCHESTRATE_TOOL,
    TASK_BOARD_TOOL,
  ],
  limits: { maxAsk: MAX_ASK, maxTurns: MAX_TURNS },
  subagents: { parallel: 3, depth: 1 },
  sideEffects: "none",
  capabilities: ["read", "skills"],
  noSubagents: true, // the teammate dispatches through its tools only
  permissionMode: "auto",
  model: SONNET_MODEL,
  thinking: { type: "adaptive" }, // the model decides how long to think (a short routing turn)
  budgetUsd: BUDGET_USD,
  promptSections: () => [chiefOfStaffContract(TEAMMATE_SKILL_REF)],
};
