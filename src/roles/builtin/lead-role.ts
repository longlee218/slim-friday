import { SONNET_MODEL } from "../../config/model-ids";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SAVE_TOOL } from "../../mcp/memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { APPROVE_PLAN_TOOL } from "../../mcp/orchestration/tools/ApprovePlanTool/constants";
import { ASK_OWNER_TOOL } from "../../mcp/orchestration/tools/AskOwnerTool/constants";
import { CANCEL_TASK_TOOL } from "../../mcp/orchestration/tools/CancelTaskTool/constants";
import { DISPATCH_AGENT_TOOL } from "../../mcp/orchestration/tools/DispatchAgentTool/constants";
import { FORWARD_RESULT_TOOL } from "../../mcp/orchestration/tools/ForwardResultTool/constants";
import { REQUEST_PLAN_TOOL } from "../../mcp/orchestration/tools/RequestPlanTool/constants";
import { SET_THREAD_TITLE_TOOL } from "../../mcp/orchestration/tools/SetThreadTitleTool/constants";
import { STEER_TASK_TOOL } from "../../mcp/orchestration/tools/SteerTaskTool/constants";
import { TASK_STATUS_TOOL } from "../../mcp/orchestration/tools/TaskStatusTool/constants";
import type { RoleDefinition } from "../role-types";

/** The lead asks the owner through its own AskOwner tool, never AskUserQuestion. */
const MAX_ASK = 0;
/** Budget (USD) of one lead run (a short routing turn); the daily lead cap is `LEAD_DAILY_BUDGET_USD`. */
const BUDGET_USD = 0.75;

/**
 * Run contract (code rules only): who the lead is and what it may do. The team (TEAM.md, built per run), the owner's
 * operating rules (AGENTS.md) and the data block are added by the runner.
 */
const CONTRACT = `This run is the lead of the team (its name and persona come from IDENTITY.md). Your reply is posted to the owner in Discord as it is. You route work, you do not do it.
- Answer only simple chat and status questions yourself; dispatch anything a team member covers (TEAM.md).
- You never write the plan yourself: a big or branching request goes to ${REQUEST_PLAN_TOOL}; the owner approves the plan once.
- You have memory tools and your lead tools only: no shell, no file changes.
- Write like a chat: short sentences, one idea per paragraph, at most 4 short paragraphs (each paragraph is sent as its own message). Put long details, tables or code after a line \`---\`: they are sent as a file.
- Never repeat secrets (keys, tokens, passwords) in a reply or a brief. In a shared channel never reveal another person's or another channel's private info or memory.`;

/**
 * The lead: Sonnet. Chosen by the lead runner (not by `entryRole`), reached only through it (`kind: "lead"`), so intent
 * routing never offers it. Its tools are the `orchestration` server's lead tools (typed actions; handlers hold the rules).
 */
export const LEAD_ROLE: RoleDefinition = {
  name: "lead",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse: "Routes the owner's messages to specialist workers and reports their results.",
  kind: "lead",
  skills: [],
  // Memory tools + the lead's typed actions + SetThreadTitle (the `orchestration` server; a worker run never gets these).
  mcpTools: [
    MEMORY_SAVE_TOOL,
    MEMORY_SEARCH_TOOL,
    MEMORY_GET_TOOL,
    MEMORY_EXPAND_TOOL,
    DISPATCH_AGENT_TOOL,
    TASK_STATUS_TOOL,
    STEER_TASK_TOOL,
    CANCEL_TASK_TOOL,
    ASK_OWNER_TOOL,
    FORWARD_RESULT_TOOL,
    REQUEST_PLAN_TOOL,
    APPROVE_PLAN_TOOL,
    SET_THREAD_TITLE_TOOL,
  ],
  limits: { maxAsk: MAX_ASK },
  sideEffects: "none",
  capabilities: ["read"],
  noSubagents: true, // depth 1: the lead dispatches through its tools only
  permissionMode: "auto",
  model: SONNET_MODEL,
  thinking: { type: "adaptive" }, // the model decides how long to think (a short routing turn)
  budgetUsd: BUDGET_USD,
  promptSections: () => [CONTRACT],
};
