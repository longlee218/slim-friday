import { FIRECRAWL_INSPECT_PAPER_TOOL } from "../../mcp/firecrawl/tools/FirecrawlInspectPaperTool/constants";
import { FIRECRAWL_MAP_TOOL } from "../../mcp/firecrawl/tools/FirecrawlMapTool/constants";
import { FIRECRAWL_READ_PAPER_TOOL } from "../../mcp/firecrawl/tools/FirecrawlReadPaperTool/constants";
import { FIRECRAWL_RELATED_PAPERS_TOOL } from "../../mcp/firecrawl/tools/FirecrawlRelatedPapersTool/constants";
import { FIRECRAWL_SCRAPE_TOOL } from "../../mcp/firecrawl/tools/FirecrawlScrapeTool/constants";
import { FIRECRAWL_SEARCH_PAPERS_TOOL } from "../../mcp/firecrawl/tools/FirecrawlSearchPapersTool/constants";
import { FIRECRAWL_SEARCH_TOOL } from "../../mcp/firecrawl/tools/FirecrawlSearchTool/constants";
import { PLAYWRIGHT_TOOLS } from "../../mcp/playwright/playwright-tool-names";
import { researcherContract } from "../prompts/contracts/researcher-contract";
import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, TEAM_SKILL } from "./specialist-contract";

/**
 * The researcher: Sonnet, read-only web and deep research with cited reports (current facts, comparisons, markets,
 * papers). Shares the roster fields (budget, turns, no owner contact) and adds the hosted search tools (built only when
 * the owner set a key). Changes no location (`sideEffects: "none"`): its report is its final reply. Split from the scout on
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
    ...PLAYWRIGHT_TOOLS,
  ],
  name: "researcher",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Facts from outside a location: versions, limits, prices, news, product or library comparisons, standards, papers, anything to verify or cite; opens public web pages. Cited report in its final reply.",
  notFor: "A location's code or files; testing an app.",
  sideEffects: "none",
  capabilities: ["read", "web", "shell", "skills"],
  skills: [
    TEAM_SKILL,
    "worker-reporting",
    "deep-research",
    "research-online",
    "firecrawl-deep-research",
    "firecrawl-research-papers",
    "firecrawl-market-research",
    "docs-seeker",
  ],
  preloadSkills: [TEAM_SKILL], // how a run fits the team is in the system prompt
  requiredSkills: ["deep-research"], // called before the first edit or command (named in one prompt line)
  promptSections: () => researcherContract(),
};
