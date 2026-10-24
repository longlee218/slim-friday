import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { EFFECTS_MCP_SERVER } from "../mcp-server-names";
import type { EffectsContext } from "./effects-context";
import { createDeletePathsTool } from "./tools/DeletePathsTool/delete-paths-tool";

/** The `effects` server of one session (built per session, never shared). */
export function effectsServer(ctx: EffectsContext) {
  return createSdkMcpServer({ name: EFFECTS_MCP_SERVER, tools: [createDeletePathsTool(ctx)] });
}
