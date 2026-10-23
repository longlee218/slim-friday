import { LIST_ARTIFACTS_TOOL } from "../mcp/artifacts/tools/ListArtifactsTool/constants";
import { READ_ARTIFACT_TOOL } from "../mcp/artifacts/tools/ReadArtifactTool/constants";
import { SAVE_ARTIFACT_TOOL } from "../mcp/artifacts/tools/SaveArtifactTool/constants";
import { SEARCH_ARTIFACTS_TOOL } from "../mcp/artifacts/tools/SearchArtifactsTool/constants";
import { CREATE_PULL_REQUEST_TOOL } from "../mcp/effects/tools/CreatePullRequestTool/constants";
import { DELETE_PATHS_TOOL } from "../mcp/effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "../mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../mcp/effects/tools/MergeBranchTool/constants";
import { FIRECRAWL_INSPECT_PAPER_TOOL } from "../mcp/firecrawl/tools/FirecrawlInspectPaperTool/constants";
import { FIRECRAWL_MAP_TOOL } from "../mcp/firecrawl/tools/FirecrawlMapTool/constants";
import { FIRECRAWL_READ_PAPER_TOOL } from "../mcp/firecrawl/tools/FirecrawlReadPaperTool/constants";
import { FIRECRAWL_RELATED_PAPERS_TOOL } from "../mcp/firecrawl/tools/FirecrawlRelatedPapersTool/constants";
import { FIRECRAWL_SCRAPE_TOOL } from "../mcp/firecrawl/tools/FirecrawlScrapeTool/constants";
import { FIRECRAWL_SEARCH_PAPERS_TOOL } from "../mcp/firecrawl/tools/FirecrawlSearchPapersTool/constants";
import { FIRECRAWL_SEARCH_TOOL } from "../mcp/firecrawl/tools/FirecrawlSearchTool/constants";
import { MEMORY_EDIT_TOOL } from "../mcp/memory/tools/MemoryEditTool/constants";
import { MEMORY_EXPAND_TOOL } from "../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SAVE_TOOL } from "../mcp/memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "../mcp/memory/tools/MemorySearchTool/constants";
import { ORCHESTRATE_TOOL } from "../mcp/orchestration/tools/OrchestrateTool/constants";
import { REPORT_TOOL } from "../mcp/orchestration/tools/ReportTool/constants";
import { TASK_BOARD_TOOL } from "../mcp/orchestration/tools/TaskBoardTool/constants";
import { PLAYWRIGHT_TOOLS } from "../mcp/playwright/playwright-tool-names";
import type { RiskClass } from "../policy/risk-types";
import type { ToolDecl, ToolNeed, ToolRunKind } from "./tool-decl";

/** Compact builder of one MCP tool entry. */
const mcp = (
  mcpTool: string,
  readOnly: boolean,
  runKinds: readonly ToolRunKind[],
  o: { risk?: RiskClass; needs?: readonly ToolNeed[] } = {},
): ToolDecl => ({
  id: mcpTool,
  mcpTool,
  readOnly,
  risk: o.risk ?? (readOnly ? "R0" : "R1"),
  needs: o.needs ?? [],
  runKinds,
});

const BOTH = ["worker", "teammate"] as const;
const TEAMMATE = ["teammate"] as const;
const WORKER = ["worker"] as const;
const EFFECT = { needs: ["effects"] } as const;

/**
 * Every in-process and external MCP tool. `runKinds` follows the ctx part each tool reads
 * (`src/mcp/manifest-types.ts`): `Orchestrate` and `SaveArtifact`/`MemorySave`/`MemoryEdit` need the teammate run
 * (workers read memory and artifacts only); `Report` the worker's report sink; the effect tools and Playwright the
 * run's effects ctx and scratch dir (a worker: its envelope and goal dir; a teammate: owner-per-act and its run dir, see
 * `teammate-effects-ctx.ts`).
 */
export const MCP_TOOL_ENTRIES: readonly ToolDecl[] = [
  mcp(MEMORY_SAVE_TOOL, false, TEAMMATE),
  mcp(MEMORY_EDIT_TOOL, false, TEAMMATE),
  mcp(MEMORY_SEARCH_TOOL, true, BOTH),
  mcp(MEMORY_GET_TOOL, true, BOTH),
  mcp(MEMORY_EXPAND_TOOL, true, BOTH),
  mcp(SAVE_ARTIFACT_TOOL, false, TEAMMATE),
  mcp(READ_ARTIFACT_TOOL, true, BOTH),
  mcp(LIST_ARTIFACTS_TOOL, true, BOTH),
  mcp(SEARCH_ARTIFACTS_TOOL, true, BOTH),
  mcp(ORCHESTRATE_TOOL, false, TEAMMATE),
  mcp(TASK_BOARD_TOOL, true, BOTH),
  mcp(REPORT_TOOL, false, WORKER),
  mcp(DELETE_PATHS_TOOL, false, BOTH, { risk: "R2", ...EFFECT }),
  mcp(MERGE_BRANCH_TOOL, false, BOTH, { risk: "R2", ...EFFECT }),
  mcp(GIT_PUSH_TOOL, false, BOTH, { risk: "R3", ...EFFECT }),
  mcp(CREATE_PULL_REQUEST_TOOL, false, BOTH, { risk: "R3", ...EFFECT }),
  // Hosted Firecrawl: reads the web, needs no ctx part.
  ...[
    FIRECRAWL_SEARCH_TOOL,
    FIRECRAWL_SCRAPE_TOOL,
    FIRECRAWL_MAP_TOOL,
    FIRECRAWL_SEARCH_PAPERS_TOOL,
    FIRECRAWL_RELATED_PAPERS_TOOL,
    FIRECRAWL_INSPECT_PAPER_TOOL,
    FIRECRAWL_READ_PAPER_TOOL,
  ].map((t) => mcp(t, true, BOTH)),
  // Playwright: a local stdio child that keeps its state in the run's scratch dir.
  ...PLAYWRIGHT_TOOLS.map((t) => mcp(t, false, BOTH, { needs: ["scratch"] })),
];
