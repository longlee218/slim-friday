import { browserMcpConfig } from "../../config/browser-mcp-config";
import type { ExternalMcpServer } from "../manifest-types";
import { BROWSER_MCP_SERVER } from "../mcp-tool-names";
import { BROWSER_TOOLS } from "./browser-tool-names";

/**
 * The local Chrome DevTools MCP server (stdio child of the CLI, pinned package, headless, a fresh profile per run; see
 * `browserMcpConfig`). Built only for a run that has its own scratch dir (a dispatched writing worker).
 */
export const BROWSER_SERVER: ExternalMcpServer = {
  name: BROWSER_MCP_SERVER,
  tools: BROWSER_TOOLS,
  config: ({ scratchDir }) => (scratchDir ? browserMcpConfig(scratchDir) : undefined),
};
