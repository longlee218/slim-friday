import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { MEMORY_MCP_SERVER } from "../mcp-server-names";
import type { FileMemory } from "./file-memory";
import type { ToolSessionContext } from "./memory-owner";
import { createMemoryEditTool } from "./tools/MemoryEditTool/memory-edit-tool";
import { createMemorySaveTool } from "./tools/MemorySaveTool/memory-save-tool";

/** The `memory` server of one session (built per session, never shared). */
export function memoryServer(memory: FileMemory, ctx: ToolSessionContext) {
  return createSdkMcpServer({
    name: MEMORY_MCP_SERVER,
    tools: [createMemorySaveTool(memory, ctx), createMemoryEditTool(memory, ctx)],
  });
}
