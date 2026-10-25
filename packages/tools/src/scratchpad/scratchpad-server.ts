import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { SCRATCHPAD_MCP_SERVER } from "../mcp-server-names";
import type { ScratchpadContext } from "./scratchpad-context";
import { createScratchpadAddTool } from "./tools/ScratchpadAddTool/scratchpad-add-tool";
import { createScratchpadCompleteTool } from "./tools/ScratchpadCompleteTool/scratchpad-complete-tool";
import { createScratchpadListTool } from "./tools/ScratchpadListTool/scratchpad-list-tool";
import { createScratchpadRemoveTool } from "./tools/ScratchpadRemoveTool/scratchpad-remove-tool";
import { createScratchpadUpdateTool } from "./tools/ScratchpadUpdateTool/scratchpad-update-tool";

/** The `scratchpad` server of one session (built per session, bound to the session's scope key). */
export function scratchpadServer(ctx: ScratchpadContext) {
  return createSdkMcpServer({
    name: SCRATCHPAD_MCP_SERVER,
    tools: [
      createScratchpadListTool(ctx),
      createScratchpadAddTool(ctx),
      createScratchpadUpdateTool(ctx),
      createScratchpadCompleteTool(ctx),
      createScratchpadRemoveTool(ctx),
    ],
  });
}
