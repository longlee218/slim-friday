import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { CHAT_MCP_SERVER } from "../mcp-server-names";
import type { ChatContext } from "./chat-context";
import { createHandOffTool } from "./tools/HandOffTool/hand-off-tool";
import { createPostFileTool } from "./tools/PostFileTool/post-file-tool";
import { createPostUpdateTool } from "./tools/PostUpdateTool/post-update-tool";
import { createSendToBotTool } from "./tools/SendToBotTool/send-to-bot-tool";
import { createSetEffortTool } from "./tools/SetEffortTool/set-effort-tool";

/** The tools of one session: `PostUpdate` for an owner run, bot-to-bot messaging only for a bot that can reach a group. */
export function chatTools(ctx: ChatContext) {
  return [
    createPostFileTool(ctx),
    createSetEffortTool(ctx),
    ...(ctx.runKind === "owner" ? [createPostUpdateTool(ctx)] : []),
    ...(ctx.messenger ? [createSendToBotTool(ctx), createHandOffTool(ctx)] : []),
  ];
}

/** The `chat` server of one session (built per session, never shared). */
export function chatServer(ctx: ChatContext) {
  return createSdkMcpServer({ name: CHAT_MCP_SERVER, tools: chatTools(ctx) });
}
