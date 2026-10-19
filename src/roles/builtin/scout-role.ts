import { HAIKU_MODEL } from "../../config/model-ids";
import { FIRECRAWL_INSPECT_PAPER_TOOL } from "../../mcp/firecrawl/tools/FirecrawlInspectPaperTool/constants";
import { FIRECRAWL_MAP_TOOL } from "../../mcp/firecrawl/tools/FirecrawlMapTool/constants";
import { FIRECRAWL_READ_PAPER_TOOL } from "../../mcp/firecrawl/tools/FirecrawlReadPaperTool/constants";
import { FIRECRAWL_RELATED_PAPERS_TOOL } from "../../mcp/firecrawl/tools/FirecrawlRelatedPapersTool/constants";
import { FIRECRAWL_SCRAPE_TOOL } from "../../mcp/firecrawl/tools/FirecrawlScrapeTool/constants";
import { FIRECRAWL_SEARCH_PAPERS_TOOL } from "../../mcp/firecrawl/tools/FirecrawlSearchPapersTool/constants";
import { FIRECRAWL_SEARCH_TOOL } from "../../mcp/firecrawl/tools/FirecrawlSearchTool/constants";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { REPORT_TOOL } from "../../mcp/orchestration/tools/ReportTool/constants";
import type { RoleDefinition } from "../role-types";
import { ARTIFACT_TOOLS } from "./artifact-tools";

/** Owner questions per run: a scout answers from what it finds and never asks. */
const MAX_ASK = 0;
/** Budget (USD) of one scout run on the cheap tier. */
const BUDGET_USD = 1.5;
/** Agent loops (SDK turns) one scout run may take. */
const MAX_TURNS = 40;

/** Run contract (facts): research that changes no location; its report is an artifact; the lead decides what reaches the owner. */
const CONTRACT = `Role: scout, a read-only research worker dispatched by the lead. Its report is saved as an artifact.
Tools: read, search and web tools, Firecrawl, and a shell in an OS sandbox with no write access: you cannot write files. Keep the shell to reads.
Skills in your list may name steps you do not have (a CLI, background runs, sub-agents, a notes file). Do such steps yourself, in sequence, or skip them.
Reporting: use the worker-reporting skill.`;

/**
 * The scout: Haiku, read + search tools, changes no location (`sideEffects: "none"`, like the lead saving memory and the
 * planner saving plans: app-owned data written by a tool is not a side effect). Its report is an artifact, written by the
 * artifact tool, never by an SDK write. Reached only through the lead (`kind: "worker"`, `dispatchable`); the lead sends
 * "where / how is X" and research jobs here. Skills are its own list (`skills`).
 */
export const SCOUT_ROLE: RoleDefinition = {
  name: "scout",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Research that changes no location: where or how something is done in a location, which files touch X, a library's current docs, general or web questions, cited reports. Its report is saved as an artifact.",
  kind: "worker",
  dispatchable: true,
  skills: [
    "worker-reporting",
    "scout",
    "docs-seeker",
    "deep-research",
    "research-online",
    "firecrawl-deep-research",
    "firecrawl-research-papers",
    "firecrawl-market-research",
  ],
  limits: { maxAsk: MAX_ASK, maxTurns: MAX_TURNS },
  subagents: { parallel: 3, depth: 1 },
  sideEffects: "none",
  capabilities: ["read", "web", "shell", "skills"],
  mcpTools: [
    MEMORY_SEARCH_TOOL,
    MEMORY_GET_TOOL,
    MEMORY_EXPAND_TOOL,
    ...ARTIFACT_TOOLS,
    REPORT_TOOL,
    FIRECRAWL_SEARCH_TOOL,
    FIRECRAWL_SCRAPE_TOOL,
    FIRECRAWL_MAP_TOOL,
    FIRECRAWL_SEARCH_PAPERS_TOOL,
    FIRECRAWL_RELATED_PAPERS_TOOL,
    FIRECRAWL_INSPECT_PAPER_TOOL,
    FIRECRAWL_READ_PAPER_TOOL,
  ],
  noSubagents: true, // subagents are developer-only (owner)
  permissionMode: "auto",
  model: HAIKU_MODEL,
  budgetUsd: BUDGET_USD,
  promptSections: () => [CONTRACT],
};
