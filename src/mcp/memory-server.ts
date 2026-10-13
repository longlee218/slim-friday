import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { MemoryToolContext } from "../tools/memory-tool-context";
import { createRememberTool } from "../tools/RememberTool/remember-tool";
import { MEMORY_MCP_SERVER } from "./mcp-tool-names";

/**
 * The in-process `memory` server of ONE run (SDK MCP server: runs in the app process, no stdio child). New memory
 * tools are added to this array (and to `MEMORY_TOOLS`, which the guard reads).
 */
export function createMemoryServer(ctx: MemoryToolContext) {
  return createSdkMcpServer({ name: MEMORY_MCP_SERVER, tools: [createRememberTool(ctx)] });
}
