import { FIRECRAWL_INSPECT_PAPER_TOOL } from "../../mcp/firecrawl/tools/FirecrawlInspectPaperTool/constants";
import { FIRECRAWL_MAP_TOOL } from "../../mcp/firecrawl/tools/FirecrawlMapTool/constants";
import { FIRECRAWL_READ_PAPER_TOOL } from "../../mcp/firecrawl/tools/FirecrawlReadPaperTool/constants";
import { FIRECRAWL_RELATED_PAPERS_TOOL } from "../../mcp/firecrawl/tools/FirecrawlRelatedPapersTool/constants";
import { FIRECRAWL_SCRAPE_TOOL } from "../../mcp/firecrawl/tools/FirecrawlScrapeTool/constants";
import { FIRECRAWL_SEARCH_PAPERS_TOOL } from "../../mcp/firecrawl/tools/FirecrawlSearchPapersTool/constants";
import { FIRECRAWL_SEARCH_TOOL } from "../../mcp/firecrawl/tools/FirecrawlSearchTool/constants";
import { researcherContract } from "../prompts/contracts/researcher-contract";
import type { RoleDefinition } from "../role-types";
import {
  SPECIALIST_BASE,
  SPECIALIST_BUDGET_USD,
  SPECIALIST_MAX_TURNS,
} from "./specialist-contract";

/**
 * The researcher: Sonnet, read-only web and deep research with cited reports (current facts, comparisons, markets,
 * papers). Shares the roster fields (budget, turns, no owner contact) and adds the hosted search tools (built only when
 * the owner set a key). Changes no location (`sideEffects: "none"`): its report is an artifact. Split from the scout on
 * 2026-10-20 (the scout keeps code lookups).
 */
export const RESEARCHER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [
    ...SPECIALIST_BASE.mcpTools,
    FIRECRAWL_SEARCH_TOOL,
    FIRECRAWL_SCRAPE_TOOL,
    FIRECRAWL_MAP_TOOL,
    FIRECRAWL_SEARCH_PAPERS_TOOL,
    FIRECRAWL_RELATED_PAPERS_TOOL,
    FIRECRAWL_INSPECT_PAPER_TOOL,
    FIRECRAWL_READ_PAPER_TOOL,
  ],
  name: "researcher",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Web research with cited sources: current facts, versions, limits, prices, product or library comparisons, standards, market data, papers. Report saved as an artifact; changes nothing.",
  sideEffects: "none",
  capabilities: ["read", "web", "shell", "skills"],
  skills: [
    "worker-reporting",
    "deep-research",
    "research-online",
    "firecrawl-deep-research",
    "firecrawl-research-papers",
    "firecrawl-market-research",
    "docs-seeker",
  ],
  requiredSkills: ["deep-research"], // called before the first edit or command (named in one prompt line)
  promptSections: () => researcherContract(),
};
