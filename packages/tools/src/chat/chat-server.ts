import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { CHAT_MCP_SERVER } from "../mcp-server-names";
import type { ChatContext } from "./chat-context";
import { createHandOffTool } from "./tools/HandOffTool/hand-off-tool";
import { createPostFileTool } from "./tools/PostFileTool/post-file-tool";
import { createPostUpdateTool } from "./tools/PostUpdateTool/post-update-tool";
import { createSendToBotTool } from "./tools/SendToBotTool/send-to-bot-tool";
import { createSetEffortTool } from "./tools/SetEffortTool/set-effort-tool";

/**
 * The tools of one session by run kind: an `owner` run gets all of them (`PostUpdate`; bot messaging only for a bot
 * that can reach a group); a `bot` run has no `PostUpdate`; a `ticket` run also no `SendToBot` / `HandOff`; an
 * `intro` run none of these (its only tools are `AskUserQuestion` and `UpdateProfile`, added with that tool).
 */
export function chatTools(ctx: ChatContext) {
  if (ctx.runKind === "intro") return [];
  return [
    createPostFileTool(ctx),
    createSetEffortTool(ctx),
    ...(ctx.runKind === "owner" ? [createPostUpdateTool(ctx)] : []),
    ...(ctx.messenger && ctx.runKind !== "ticket"
      ? [createSendToBotTool(ctx), createHandOffTool(ctx)]
      : []),
  ];
}

/** The `chat` server of one session (built per session, never shared). */
export function chatServer(ctx: ChatContext) {
  return createSdkMcpServer({ name: CHAT_MCP_SERVER, tools: chatTools(ctx) });
}
