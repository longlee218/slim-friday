import { MCP_PREFIX } from "../mcp/mcp-tool-names";

/**
 * Refusal codes that are the normal answer of a tool to a stale or undecided state, not a fault to look at:
 * the task already ended, the owner's reply asks for a change, the owner did not answer, the goal is closed.
 */
const EXPECTED_REFUSALS = ["ENDED", "UNCLEAR", "TIMEOUT", "GOAL_NOT_OPEN"];

/** Log level of a refused teammate tool call (`teammate.decision`): a real refusal is a warning, an expected one stays info. */
export function refusalLevel(ok: boolean, code?: string): "info" | "warn" {
  return ok || (code && EXPECTED_REFUSALS.includes(code)) ? "info" : "warn";
}

/**
 * Log level of a finished tool call (`tool.done`). A failed Friday MCP tool is a warning (its `err` starts with the
 * JSON refusal, so the code is read from there); a failed SDK tool (Bash exit 1, a missed edit) is routine and stays info.
 */
export function toolDoneLevel(tool: string, isError: boolean, err?: string): "info" | "warn" {
  if (!isError || !tool.startsWith(MCP_PREFIX)) return "info";
  return EXPECTED_REFUSALS.some((c) => err?.includes(`"code":"${c}"`)) ? "info" : "warn";
}
