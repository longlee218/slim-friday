import type { McpServerManifest } from "../manifest-types";
import { TEAMMATES_MCP_SERVER } from "../mcp-tool-names";
import { MESSAGE_TEAMMATE_TOOL } from "./tools/MessageTeammateTool/constants";
import { createMessageTeammateTool } from "./tools/MessageTeammateTool/message-teammate-tool";

/** The `teammates` server: how a teammate talks to the other teammates. Needs the run's `peer` ctx part. */
export const TEAMMATES_SERVER: McpServerManifest = {
  name: TEAMMATES_MCP_SERVER,
  tools: [
    { name: MESSAGE_TEAMMATE_TOOL, create: (c) => c.peer && createMessageTeammateTool(c.peer) },
  ],
};
