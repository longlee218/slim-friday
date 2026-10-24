import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { CHAT_MCP_SERVER } from "../mcp-server-names";
import type { ChatContext } from "./chat-context";
import { createPostFileTool } from "./tools/PostFileTool/post-file-tool";
import { createSetEffortTool } from "./tools/SetEffortTool/set-effort-tool";

/** The `chat` server of one session (built per session, never shared). */
export function chatServer(ctx: ChatContext) {
  return createSdkMcpServer({
    name: CHAT_MCP_SERVER,
    tools: [createPostFileTool(ctx), createSetEffortTool(ctx)],
  });
}
