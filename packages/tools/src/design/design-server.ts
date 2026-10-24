import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { DESIGN_MCP_SERVER } from "../mcp-server-names";
import type { DesignContext } from "./design-context";
import { createBotDesignTool } from "./tools/BotDesignTool/bot-design-tool";
import { createBotInsightTool } from "./tools/BotInsightTool/bot-insight-tool";
import { createBotLookupTool } from "./tools/BotLookupTool/bot-lookup-tool";

/** The `design` server of one session (built per session, never shared). */
export function designServer(ctx: DesignContext) {
  return createSdkMcpServer({
    name: DESIGN_MCP_SERVER,
    tools: [createBotLookupTool(ctx), createBotDesignTool(ctx), createBotInsightTool(ctx)],
  });
}
