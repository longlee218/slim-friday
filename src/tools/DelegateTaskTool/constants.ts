import { mcpToolName, TASKS_MCP_SERVER } from "../../mcp/mcp-tool-names";

/** Name of the Q&A handoff tool (the tool as the in-process server `tasks` registers it). */
export const DELEGATE_TASK_TOOL_NAME = "DelegateTask";

/** Full SDK name the agent sees and the guard checks: `mcp__tasks__DelegateTask`. */
export const DELEGATE_TASK_MCP_TOOL_NAME = mcpToolName(TASKS_MCP_SERVER, DELEGATE_TASK_TOOL_NAME);
