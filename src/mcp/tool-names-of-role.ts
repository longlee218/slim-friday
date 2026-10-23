import type { RoleDefinition } from "../roles/role-types";
import { policyOf } from "../tools/role-policy";
import { CREATE_PULL_REQUEST_TOOL } from "./effects/tools/CreatePullRequestTool/constants";
import { DELETE_PATHS_TOOL } from "./effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "./effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "./effects/tools/MergeBranchTool/constants";
import { FIRECRAWL_INSPECT_PAPER_TOOL } from "./firecrawl/tools/FirecrawlInspectPaperTool/constants";
import { FIRECRAWL_MAP_TOOL } from "./firecrawl/tools/FirecrawlMapTool/constants";
import { FIRECRAWL_READ_PAPER_TOOL } from "./firecrawl/tools/FirecrawlReadPaperTool/constants";
import { FIRECRAWL_RELATED_PAPERS_TOOL } from "./firecrawl/tools/FirecrawlRelatedPapersTool/constants";
import { FIRECRAWL_SCRAPE_TOOL } from "./firecrawl/tools/FirecrawlScrapeTool/constants";
import { FIRECRAWL_SEARCH_PAPERS_TOOL } from "./firecrawl/tools/FirecrawlSearchPapersTool/constants";
import { FIRECRAWL_SEARCH_TOOL } from "./firecrawl/tools/FirecrawlSearchTool/constants";
import {
  EFFECTS_MCP_SERVER,
  FIRECRAWL_MCP_SERVER,
  MEMORY_MCP_SERVER,
  mcpToolName,
  PLAYWRIGHT_MCP_SERVER,
} from "./mcp-tool-names";
import { MEMORY_EDIT_TOOL } from "./memory/tools/MemoryEditTool/constants";
import { MEMORY_EXPAND_TOOL } from "./memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "./memory/tools/MemoryGetTool/constants";
import { MEMORY_SAVE_TOOL } from "./memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "./memory/tools/MemorySearchTool/constants";
import { PLAYWRIGHT_TOOLS } from "./playwright/playwright-tool-names";

/**
 * Server of every MCP tool, by bare tool name. Leaf data (imports only `constants.ts` files and server names, never
 * tool code), so the guard can list a role's MCP tools without loading the tool graph. A test checks that it matches
 * the server manifests exactly.
 */
export const MCP_TOOL_SERVER: Readonly<Record<string, string>> = {
  [CREATE_PULL_REQUEST_TOOL]: EFFECTS_MCP_SERVER,
  [DELETE_PATHS_TOOL]: EFFECTS_MCP_SERVER,
  [GIT_PUSH_TOOL]: EFFECTS_MCP_SERVER,
  [MERGE_BRANCH_TOOL]: EFFECTS_MCP_SERVER,
  [MEMORY_EDIT_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_EXPAND_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_GET_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_SAVE_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_SEARCH_TOOL]: MEMORY_MCP_SERVER,
  [FIRECRAWL_SEARCH_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_SCRAPE_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_MAP_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_SEARCH_PAPERS_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_RELATED_PAPERS_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_INSPECT_PAPER_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_READ_PAPER_TOOL]: FIRECRAWL_MCP_SERVER,
  ...Object.fromEntries(PLAYWRIGHT_TOOLS.map((t) => [t, PLAYWRIGHT_MCP_SERVER])),
};

/** Full names (`mcp__<server>__<tool>`) of the MCP tools of a role (the guard allows exactly these). */
export const mcpToolNamesOfRole = (role: RoleDefinition): string[] =>
  policyOf(role).mcpTools.flatMap((t) => {
    const server = MCP_TOOL_SERVER[t];
    return server ? [mcpToolName(server, t)] : [];
  });
