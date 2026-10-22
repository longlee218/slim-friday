import { playwrightMcpConfig } from "../../config/playwright-mcp-config";
import type { ExternalMcpServer } from "../manifest-types";
import { PLAYWRIGHT_MCP_SERVER } from "../mcp-tool-names";
import { PLAYWRIGHT_TOOLS } from "./playwright-tool-names";

/**
 * The local Playwright MCP server (stdio child of the CLI, pinned package, headless, a fresh in-memory profile per
 * run; see `playwrightMcpConfig`). Connected only for a run that has its own scratch dir (a dispatched worker).
 */
export const PLAYWRIGHT_SERVER: ExternalMcpServer = {
  name: PLAYWRIGHT_MCP_SERVER,
  tools: PLAYWRIGHT_TOOLS,
  config: ({ scratchDir }) => (scratchDir ? playwrightMcpConfig(scratchDir) : undefined),
};
