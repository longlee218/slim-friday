import { FIRECRAWL_MCP_URL, firecrawlApiKey } from "../../config/firecrawl-config";
import type { ExternalMcpServer } from "../manifest-types";
import { FIRECRAWL_MCP_SERVER } from "../mcp-tool-names";
import { FIRECRAWL_INSPECT_PAPER_TOOL } from "./tools/FirecrawlInspectPaperTool/constants";
import { FIRECRAWL_MAP_TOOL } from "./tools/FirecrawlMapTool/constants";
import { FIRECRAWL_READ_PAPER_TOOL } from "./tools/FirecrawlReadPaperTool/constants";
import { FIRECRAWL_RELATED_PAPERS_TOOL } from "./tools/FirecrawlRelatedPapersTool/constants";
import { FIRECRAWL_SCRAPE_TOOL } from "./tools/FirecrawlScrapeTool/constants";
import { FIRECRAWL_SEARCH_PAPERS_TOOL } from "./tools/FirecrawlSearchPapersTool/constants";
import { FIRECRAWL_SEARCH_TOOL } from "./tools/FirecrawlSearchTool/constants";

/**
 * The hosted Firecrawl MCP server, reached over Streamable HTTP by the SDK itself (no child process, so the worker
 * sandbox does not apply to it). Built only when `FIRECRAWL_API_KEY` is set; without it a role keeps WebSearch/WebFetch.
 */
export const FIRECRAWL_SERVER: ExternalMcpServer = {
  name: FIRECRAWL_MCP_SERVER,
  tools: [
    FIRECRAWL_SEARCH_TOOL,
    FIRECRAWL_SCRAPE_TOOL,
    FIRECRAWL_MAP_TOOL,
    FIRECRAWL_SEARCH_PAPERS_TOOL,
    FIRECRAWL_RELATED_PAPERS_TOOL,
    FIRECRAWL_INSPECT_PAPER_TOOL,
    FIRECRAWL_READ_PAPER_TOOL,
  ],
  config: () => {
    const key = firecrawlApiKey();
    return key
      ? { type: "http", url: FIRECRAWL_MCP_URL, headers: { Authorization: `Bearer ${key}` } }
      : undefined;
  },
};
