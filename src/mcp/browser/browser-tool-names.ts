import { BROWSER_CLICK_TOOL } from "./tools/BrowserClickTool/constants";
import { BROWSER_CLOSE_PAGE_TOOL } from "./tools/BrowserClosePageTool/constants";
import { BROWSER_DRAG_TOOL } from "./tools/BrowserDragTool/constants";
import { BROWSER_EMULATE_TOOL } from "./tools/BrowserEmulateTool/constants";
import { BROWSER_EVALUATE_SCRIPT_TOOL } from "./tools/BrowserEvaluateScriptTool/constants";
import { BROWSER_FILL_FORM_TOOL } from "./tools/BrowserFillFormTool/constants";
import { BROWSER_FILL_TOOL } from "./tools/BrowserFillTool/constants";
import { BROWSER_GET_CONSOLE_MESSAGE_TOOL } from "./tools/BrowserGetConsoleMessageTool/constants";
import { BROWSER_GET_CSS_STYLES_TOOL } from "./tools/BrowserGetCssStylesTool/constants";
import { BROWSER_GET_NETWORK_REQUEST_TOOL } from "./tools/BrowserGetNetworkRequestTool/constants";
import { BROWSER_HANDLE_DIALOG_TOOL } from "./tools/BrowserHandleDialogTool/constants";
import { BROWSER_HOVER_TOOL } from "./tools/BrowserHoverTool/constants";
import { BROWSER_LIGHTHOUSE_AUDIT_TOOL } from "./tools/BrowserLighthouseAuditTool/constants";
import { BROWSER_LIST_CONSOLE_MESSAGES_TOOL } from "./tools/BrowserListConsoleMessagesTool/constants";
import { BROWSER_LIST_NETWORK_REQUESTS_TOOL } from "./tools/BrowserListNetworkRequestsTool/constants";
import { BROWSER_LIST_PAGES_TOOL } from "./tools/BrowserListPagesTool/constants";
import { BROWSER_NAVIGATE_PAGE_TOOL } from "./tools/BrowserNavigatePageTool/constants";
import { BROWSER_NEW_PAGE_TOOL } from "./tools/BrowserNewPageTool/constants";
import { BROWSER_PRESS_KEY_TOOL } from "./tools/BrowserPressKeyTool/constants";
import { BROWSER_RESIZE_PAGE_TOOL } from "./tools/BrowserResizePageTool/constants";
import { BROWSER_SELECT_PAGE_TOOL } from "./tools/BrowserSelectPageTool/constants";
import { BROWSER_TAKE_SCREENSHOT_TOOL } from "./tools/BrowserTakeScreenshotTool/constants";
import { BROWSER_TAKE_SNAPSHOT_TOOL } from "./tools/BrowserTakeSnapshotTool/constants";
import { BROWSER_TYPE_TEXT_TOOL } from "./tools/BrowserTypeTextTool/constants";
import { BROWSER_WAIT_FOR_TOOL } from "./tools/BrowserWaitForTool/constants";

/**
 * The tools a role may be given from the Chrome DevTools MCP server: pages and navigation, input, emulation, network,
 * console, snapshots, screenshots and Lighthouse. Left out on purpose (the guard denies them): `upload_file` (sends any
 * local file the server can read to a page), the performance traces, and the extension, memory, PWA and third-party
 * tools (off by default in the server).
 */
export const BROWSER_TOOLS: string[] = [
  BROWSER_NAVIGATE_PAGE_TOOL,
  BROWSER_NEW_PAGE_TOOL,
  BROWSER_LIST_PAGES_TOOL,
  BROWSER_SELECT_PAGE_TOOL,
  BROWSER_CLOSE_PAGE_TOOL,
  BROWSER_WAIT_FOR_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_DRAG_TOOL,
  BROWSER_FILL_TOOL,
  BROWSER_FILL_FORM_TOOL,
  BROWSER_HOVER_TOOL,
  BROWSER_PRESS_KEY_TOOL,
  BROWSER_TYPE_TEXT_TOOL,
  BROWSER_HANDLE_DIALOG_TOOL,
  BROWSER_EMULATE_TOOL,
  BROWSER_RESIZE_PAGE_TOOL,
  BROWSER_LIST_NETWORK_REQUESTS_TOOL,
  BROWSER_GET_NETWORK_REQUEST_TOOL,
  BROWSER_EVALUATE_SCRIPT_TOOL,
  BROWSER_LIST_CONSOLE_MESSAGES_TOOL,
  BROWSER_GET_CONSOLE_MESSAGE_TOOL,
  BROWSER_GET_CSS_STYLES_TOOL,
  BROWSER_LIGHTHOUSE_AUDIT_TOOL,
  BROWSER_TAKE_SCREENSHOT_TOOL,
  BROWSER_TAKE_SNAPSHOT_TOOL,
];
