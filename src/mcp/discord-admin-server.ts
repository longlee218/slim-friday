import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createCreateSpaceOrChannelTool } from "../tools/CreateSpaceOrChannelTool/create-space-or-channel-tool";
import type { DiscordAdminContext } from "../tools/discord-admin-context";
import { createListSpacesTool } from "../tools/ListSpacesTool/list-spaces-tool";
import { createWriteSpaceFileTool } from "../tools/WriteSpaceFileTool/write-space-file-tool";
import { DISCORD_ADMIN_MCP_SERVER } from "./mcp-tool-names";

/**
 * The in-process `discord-admin` server of ONE control-channel run (SDK MCP server: runs in the app process).
 * Three tools: list, create (create-only) and write a space file (diff + owner confirm). New tools are added here AND
 * to `APP_MCP_TOOLS`, which the guard reads. The agent never holds the Discord token.
 */
export function createDiscordAdminServer(ctx: DiscordAdminContext) {
  return createSdkMcpServer({
    name: DISCORD_ADMIN_MCP_SERVER,
    tools: [
      createListSpacesTool(ctx),
      createCreateSpaceOrChannelTool(ctx),
      createWriteSpaceFileTool(ctx),
    ],
  });
}
