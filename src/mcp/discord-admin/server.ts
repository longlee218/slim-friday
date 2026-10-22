import type { DiscordAdminContext } from "../../providers/discord/setup/discord-admin-context";
import type { McpServerManifest } from "../manifest-types";
import { DISCORD_ADMIN_MCP_SERVER } from "../mcp-tool-names";
import { CREATE_SPACE_OR_CHANNEL_TOOL } from "./tools/CreateSpaceOrChannelTool/constants";
import { createCreateSpaceOrChannelTool } from "./tools/CreateSpaceOrChannelTool/create-space-or-channel-tool";
import { LIST_SPACES_TOOL } from "./tools/ListSpacesTool/constants";
import { createListSpacesTool } from "./tools/ListSpacesTool/list-spaces-tool";
import { WRITE_SPACE_FILE_TOOL } from "./tools/WriteSpaceFileTool/constants";
import { createWriteSpaceFileTool } from "./tools/WriteSpaceFileTool/write-space-file-tool";

/**
 * The `discord-admin` server (control-channel run): list, create (create-only) and write a space file (diff + owner
 * confirm). The agent never holds the Discord token.
 */
export const DISCORD_ADMIN_SERVER: McpServerManifest = {
  name: DISCORD_ADMIN_MCP_SERVER,
  tools: [
    {
      name: LIST_SPACES_TOOL,
      create: (c) => c.admin && createListSpacesTool(c.admin as DiscordAdminContext),
    },
    {
      name: CREATE_SPACE_OR_CHANNEL_TOOL,
      create: (c) => c.admin && createCreateSpaceOrChannelTool(c.admin as DiscordAdminContext),
    },
    {
      name: WRITE_SPACE_FILE_TOOL,
      create: (c) => c.admin && createWriteSpaceFileTool(c.admin as DiscordAdminContext),
    },
  ],
};
