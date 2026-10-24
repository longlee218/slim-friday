import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { MEMORY_MCP_SERVER } from "../mcp-server-names";
import type { FileMemory } from "./file-memory";
import type { ToolSessionContext } from "./memory-owner";
import type { MemoryRecall } from "./recall/memory-recall";
import { createMemoryEditTool } from "./tools/MemoryEditTool/memory-edit-tool";
import { createMemorySaveTool } from "./tools/MemorySaveTool/memory-save-tool";
import { createMemorySearchTool } from "./tools/MemorySearchTool/memory-search-tool";
import {
  createMessageSearchTool,
  type MessageSearchDeps,
} from "./tools/MessageSearchTool/message-search-tool";

/** The `memory` server of one session (built per session, never shared); `MessageSearch` only when `messages` is given. */
export function memoryServer(
  memory: FileMemory,
  recall: MemoryRecall,
  ctx: ToolSessionContext,
  messages?: MessageSearchDeps,
) {
  return createSdkMcpServer({
    name: MEMORY_MCP_SERVER,
    tools: [
      createMemorySaveTool(memory, ctx),
      createMemoryEditTool(memory, ctx),
      createMemorySearchTool(recall, ctx),
      ...(messages ? [createMessageSearchTool(messages, ctx)] : []),
    ],
  });
}
