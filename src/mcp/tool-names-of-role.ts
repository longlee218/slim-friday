import type { RoleDefinition } from "../roles/role-types";
import { LIST_ARTIFACTS_TOOL } from "./artifacts/tools/ListArtifactsTool/constants";
import { READ_ARTIFACT_TOOL } from "./artifacts/tools/ReadArtifactTool/constants";
import { SAVE_ARTIFACT_TOOL } from "./artifacts/tools/SaveArtifactTool/constants";
import { SEARCH_ARTIFACTS_TOOL } from "./artifacts/tools/SearchArtifactsTool/constants";
import { BROWSER_CLICK_TOOL } from "./browser/tools/BrowserClickTool/constants";
import { BROWSER_CLOSE_PAGE_TOOL } from "./browser/tools/BrowserClosePageTool/constants";
import { BROWSER_DRAG_TOOL } from "./browser/tools/BrowserDragTool/constants";
import { BROWSER_EMULATE_TOOL } from "./browser/tools/BrowserEmulateTool/constants";
import { BROWSER_EVALUATE_SCRIPT_TOOL } from "./browser/tools/BrowserEvaluateScriptTool/constants";
import { BROWSER_FILL_FORM_TOOL } from "./browser/tools/BrowserFillFormTool/constants";
import { BROWSER_FILL_TOOL } from "./browser/tools/BrowserFillTool/constants";
import { BROWSER_GET_CONSOLE_MESSAGE_TOOL } from "./browser/tools/BrowserGetConsoleMessageTool/constants";
import { BROWSER_GET_CSS_STYLES_TOOL } from "./browser/tools/BrowserGetCssStylesTool/constants";
import { BROWSER_GET_NETWORK_REQUEST_TOOL } from "./browser/tools/BrowserGetNetworkRequestTool/constants";
import { BROWSER_HANDLE_DIALOG_TOOL } from "./browser/tools/BrowserHandleDialogTool/constants";
import { BROWSER_HOVER_TOOL } from "./browser/tools/BrowserHoverTool/constants";
import { BROWSER_LIGHTHOUSE_AUDIT_TOOL } from "./browser/tools/BrowserLighthouseAuditTool/constants";
import { BROWSER_LIST_CONSOLE_MESSAGES_TOOL } from "./browser/tools/BrowserListConsoleMessagesTool/constants";
import { BROWSER_LIST_NETWORK_REQUESTS_TOOL } from "./browser/tools/BrowserListNetworkRequestsTool/constants";
import { BROWSER_LIST_PAGES_TOOL } from "./browser/tools/BrowserListPagesTool/constants";
import { BROWSER_NAVIGATE_PAGE_TOOL } from "./browser/tools/BrowserNavigatePageTool/constants";
import { BROWSER_NEW_PAGE_TOOL } from "./browser/tools/BrowserNewPageTool/constants";
import { BROWSER_PRESS_KEY_TOOL } from "./browser/tools/BrowserPressKeyTool/constants";
import { BROWSER_RESIZE_PAGE_TOOL } from "./browser/tools/BrowserResizePageTool/constants";
import { BROWSER_SELECT_PAGE_TOOL } from "./browser/tools/BrowserSelectPageTool/constants";
import { BROWSER_TAKE_SCREENSHOT_TOOL } from "./browser/tools/BrowserTakeScreenshotTool/constants";
import { BROWSER_TAKE_SNAPSHOT_TOOL } from "./browser/tools/BrowserTakeSnapshotTool/constants";
import { BROWSER_TYPE_TEXT_TOOL } from "./browser/tools/BrowserTypeTextTool/constants";
import { BROWSER_WAIT_FOR_TOOL } from "./browser/tools/BrowserWaitForTool/constants";
import { CREATE_SPACE_OR_CHANNEL_TOOL } from "./discord-admin/tools/CreateSpaceOrChannelTool/constants";
import { LIST_SPACES_TOOL } from "./discord-admin/tools/ListSpacesTool/constants";
import { WRITE_SPACE_FILE_TOOL } from "./discord-admin/tools/WriteSpaceFileTool/constants";
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
  ARTIFACTS_MCP_SERVER,
  BROWSER_MCP_SERVER,
  DISCORD_ADMIN_MCP_SERVER,
  EFFECTS_MCP_SERVER,
  FIRECRAWL_MCP_SERVER,
  MEMORY_MCP_SERVER,
  mcpToolName,
  ORCHESTRATION_MCP_SERVER,
  PLAN_MCP_SERVER,
} from "./mcp-tool-names";
import { MEMORY_EXPAND_TOOL } from "./memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "./memory/tools/MemoryGetTool/constants";
import { MEMORY_SAVE_TOOL } from "./memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "./memory/tools/MemorySearchTool/constants";
import { ORCHESTRATE_TOOL } from "./orchestration/tools/OrchestrateTool/constants";
import { REPORT_TOOL } from "./orchestration/tools/ReportTool/constants";
import { PLAN_TOOL } from "./plan/tools/PlanTool/constants";

/**
 * Server of every MCP tool, by bare tool name. Leaf data (imports only `constants.ts` files and server names, never
 * tool code), so the guard can list a role's MCP tools without loading the tool graph. A test checks that it matches
 * the server manifests exactly.
 */
export const MCP_TOOL_SERVER: Readonly<Record<string, string>> = {
  [LIST_ARTIFACTS_TOOL]: ARTIFACTS_MCP_SERVER,
  [READ_ARTIFACT_TOOL]: ARTIFACTS_MCP_SERVER,
  [SAVE_ARTIFACT_TOOL]: ARTIFACTS_MCP_SERVER,
  [SEARCH_ARTIFACTS_TOOL]: ARTIFACTS_MCP_SERVER,
  [CREATE_SPACE_OR_CHANNEL_TOOL]: DISCORD_ADMIN_MCP_SERVER,
  [LIST_SPACES_TOOL]: DISCORD_ADMIN_MCP_SERVER,
  [WRITE_SPACE_FILE_TOOL]: DISCORD_ADMIN_MCP_SERVER,
  [CREATE_PULL_REQUEST_TOOL]: EFFECTS_MCP_SERVER,
  [DELETE_PATHS_TOOL]: EFFECTS_MCP_SERVER,
  [GIT_PUSH_TOOL]: EFFECTS_MCP_SERVER,
  [MERGE_BRANCH_TOOL]: EFFECTS_MCP_SERVER,
  [MEMORY_EXPAND_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_GET_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_SAVE_TOOL]: MEMORY_MCP_SERVER,
  [MEMORY_SEARCH_TOOL]: MEMORY_MCP_SERVER,
  [ORCHESTRATE_TOOL]: ORCHESTRATION_MCP_SERVER,
  [REPORT_TOOL]: ORCHESTRATION_MCP_SERVER,
  [PLAN_TOOL]: PLAN_MCP_SERVER,
  [FIRECRAWL_SEARCH_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_SCRAPE_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_MAP_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_SEARCH_PAPERS_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_RELATED_PAPERS_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_INSPECT_PAPER_TOOL]: FIRECRAWL_MCP_SERVER,
  [FIRECRAWL_READ_PAPER_TOOL]: FIRECRAWL_MCP_SERVER,
  [BROWSER_NAVIGATE_PAGE_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_NEW_PAGE_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_LIST_PAGES_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_SELECT_PAGE_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_CLOSE_PAGE_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_WAIT_FOR_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_CLICK_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_DRAG_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_FILL_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_FILL_FORM_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_HOVER_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_PRESS_KEY_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_TYPE_TEXT_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_HANDLE_DIALOG_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_EMULATE_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_RESIZE_PAGE_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_LIST_NETWORK_REQUESTS_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_GET_NETWORK_REQUEST_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_EVALUATE_SCRIPT_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_LIST_CONSOLE_MESSAGES_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_GET_CONSOLE_MESSAGE_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_GET_CSS_STYLES_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_LIGHTHOUSE_AUDIT_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_TAKE_SCREENSHOT_TOOL]: BROWSER_MCP_SERVER,
  [BROWSER_TAKE_SNAPSHOT_TOOL]: BROWSER_MCP_SERVER,
};

/** Full names (`mcp__<server>__<tool>`) of the MCP tools of a role (the guard allows exactly these). */
export const mcpToolNamesOfRole = (role: RoleDefinition): string[] =>
  (role.mcpTools ?? []).flatMap((t) => {
    const server = MCP_TOOL_SERVER[t];
    return server ? [mcpToolName(server, t)] : [];
  });
