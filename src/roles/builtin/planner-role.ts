import { MAX_WAVES, PLAN_MAX_CRITERIA, PLAN_MAX_ITEMS } from "../../config/lead-caps";
import { SONNET_MODEL } from "../../config/model-ids";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { REPORT_TOOL } from "../../mcp/orchestration/tools/ReportTool/constants";
import { PLAN_TOOL } from "../../mcp/plan/tools/PlanTool/constants";
import type { RoleDefinition } from "../role-types";
import { ARTIFACT_TOOLS } from "./artifact-tools";

/** Owner questions per run: the planner never asks; when it cannot plan it reports NEEDS_CLARIFICATION and the lead asks. */
const MAX_ASK = 0;
/** Budget (USD) of one planner run (counted in the goal budget). */
const BUDGET_USD = 1.0;
/** Agent loops (SDK turns) one planner run may take. */
const MAX_TURNS = 40;

/** Run contract (facts): plan only, through the plan tools; the lead and the owner decide the rest. */
const CONTRACT = `Role: planner, a read-only worker dispatched by the lead. It turns the lead's request into one plan the owner approves once. It writes no code and has no owner contact.
Caps (code): ${PLAN_MAX_ITEMS} items per plan version; 1-${PLAN_MAX_CRITERIA} acceptance criteria; ${MAX_WAVES} planner runs per goal.
Running items change only through a plan revision.
If the request is too unclear to plan, finish with NEEDS_CLARIFICATION and the one question that unblocks you.
Finish once with the report's result: COMPLETED with the plan id and version (the lead then asks the owner to approve), or BLOCKED, NEEDS_CLARIFICATION or FAILED. The blocker action is refused for you.`;

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
  promptSections: () => [CONTRACT],
};
