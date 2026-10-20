import { SONNET_MODEL } from "../../config/model-ids";
import { ARTIFACT_TOOLS } from "../../mcp/artifacts/artifact-tool-names";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { REPORT_TOOL } from "../../mcp/orchestration/tools/ReportTool/constants";
import { PLAN_TOOL } from "../../mcp/plan/tools/PlanTool/constants";
import { plannerContract } from "../prompts/contracts/planner-contract";
import type { RoleDefinition } from "../role-types";

/** Owner questions per run: the planner never asks; when it cannot plan it reports NEEDS_CLARIFICATION and the lead asks. */
const MAX_ASK = 0;
/** Budget (USD) of one planner run (counted in the goal budget). */
const BUDGET_USD = 2.0;
/** Agent loops (SDK turns) one planner run may take. */
const MAX_TURNS = 40;

/**
 * The planner: Sonnet, read-only worker. Reached only through the lead's `Orchestrate request_plan` (`kind: "worker"`, not
 * `dispatchable`, so `Orchestrate dispatch` can never start it and a plan can never list it). Skills are data: no publisher
 * skill (their flows write plan files and ask the owner, which this role must not do), only the app-owned `plan-work`
 * checklist.
 */
export const PLANNER_ROLE: RoleDefinition = {
  name: "planner",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Turns a big or branching request into a validated plan with items, dependencies, risks and an envelope.",
  kind: "worker",
  skills: ["plan-work"],
  limits: { maxAsk: MAX_ASK, maxTurns: MAX_TURNS },
  subagents: { parallel: 3, depth: 1 },
  sideEffects: "none",
  capabilities: ["read", "skills"],
  mcpTools: [
    MEMORY_SEARCH_TOOL,
    MEMORY_GET_TOOL,
    MEMORY_EXPAND_TOOL,
    ...ARTIFACT_TOOLS,
    REPORT_TOOL,
    PLAN_TOOL,
  ],
  noSubagents: true, // subagents are developer-only (owner)
  permissionMode: "auto",
  model: SONNET_MODEL,
  budgetUsd: BUDGET_USD,
  promptSections: () => plannerContract(),
};
