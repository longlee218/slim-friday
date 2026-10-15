import type { GuardrailContext } from "../../guardrails/check-tool-call";
import {
  CREATE_PULL_REQUEST_TOOL,
  DELETE_PATHS_TOOL,
  EFFECTS_MCP_SERVER,
  GIT_PUSH_TOOL,
  MCP_PREFIX,
  MERGE_BRANCH_TOOL,
  mcpToolName,
} from "../../mcp/mcp-tool-names";
import {
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LSP_TOOL_NAME,
  MONITOR_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../../tools/sdk-tool-names";
import { classifyBash } from "./bash-allowlist";
import type { RiskClass } from "./risk-types";

/* Risk class (R0-R4) of one tool call. Pure and deterministic: tool name + input -> class. Unknown -> R2.
   R4 is not decided here: it depends on facts only the effect tools see (default branch, a location outside the goal). */

const READ = new Set([READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME, LSP_TOOL_NAME]);
const WRITE = new Set([
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]);
const EFFECT_CLASS: Record<string, RiskClass> = {
  [DELETE_PATHS_TOOL]: "R2",
  [MERGE_BRANCH_TOOL]: "R2",
  [GIT_PUSH_TOOL]: "R3",
  [CREATE_PULL_REQUEST_TOOL]: "R3",
};

/** Class of a tool call; `ctx` gives a Bash line its cwd and write dirs. */
export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): RiskClass {
  if (READ.has(toolName)) return "R0";
  // Edit / Write: the file guard already limits the path to the write dirs of the run (the location, the goal dir).
  if (WRITE.has(toolName)) return "R1";
  if (toolName === BASH_TOOL_NAME || toolName === MONITOR_TOOL_NAME)
    return typeof input.command === "string" ? classifyBash(input.command, ctx).risk : "R2";
  if (toolName.startsWith(MCP_PREFIX)) {
    for (const [tool, risk] of Object.entries(EFFECT_CLASS))
      if (toolName === mcpToolName(EFFECTS_MCP_SERVER, tool)) return risk;
  }
  return "R2";
}
