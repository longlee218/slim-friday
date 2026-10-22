import { BROWSER_CLICK_TOOL } from "./tools/BrowserClickTool/constants";
import { BROWSER_CLOSE_TOOL } from "./tools/BrowserCloseTool/constants";
import { BROWSER_CONSOLE_MESSAGES_TOOL } from "./tools/BrowserConsoleMessagesTool/constants";
import { BROWSER_DRAG_TOOL } from "./tools/BrowserDragTool/constants";
import { BROWSER_DROP_TOOL } from "./tools/BrowserDropTool/constants";
import { BROWSER_EMULATE_MEDIA_TOOL } from "./tools/BrowserEmulateMediaTool/constants";
import { BROWSER_EVALUATE_TOOL } from "./tools/BrowserEvaluateTool/constants";
import { BROWSER_FILE_UPLOAD_TOOL } from "./tools/BrowserFileUploadTool/constants";
import { BROWSER_FILL_FORM_TOOL } from "./tools/BrowserFillFormTool/constants";
import { BROWSER_FIND_TOOL } from "./tools/BrowserFindTool/constants";
import { BROWSER_HANDLE_DIALOG_TOOL } from "./tools/BrowserHandleDialogTool/constants";
import { BROWSER_HOVER_TOOL } from "./tools/BrowserHoverTool/constants";
import { BROWSER_NAVIGATE_BACK_TOOL } from "./tools/BrowserNavigateBackTool/constants";
import { BROWSER_NAVIGATE_TOOL } from "./tools/BrowserNavigateTool/constants";
import { BROWSER_NETWORK_REQUESTS_TOOL } from "./tools/BrowserNetworkRequestsTool/constants";
import { BROWSER_NETWORK_REQUEST_TOOL } from "./tools/BrowserNetworkRequestTool/constants";
import { BROWSER_PRESS_KEY_TOOL } from "./tools/BrowserPressKeyTool/constants";
import { BROWSER_RESIZE_TOOL } from "./tools/BrowserResizeTool/constants";
import { BROWSER_RUN_CODE_UNSAFE_TOOL } from "./tools/BrowserRunCodeUnsafeTool/constants";
import { BROWSER_SELECT_OPTION_TOOL } from "./tools/BrowserSelectOptionTool/constants";
import { BROWSER_SNAPSHOT_TOOL } from "./tools/BrowserSnapshotTool/constants";
import { BROWSER_TABS_TOOL } from "./tools/BrowserTabsTool/constants";
import { BROWSER_TAKE_SCREENSHOT_TOOL } from "./tools/BrowserTakeScreenshotTool/constants";
import { BROWSER_TYPE_TOOL } from "./tools/BrowserTypeTool/constants";
import { BROWSER_WAIT_FOR_TOOL } from "./tools/BrowserWaitForTool/constants";

/**
 * Every tool of the Playwright MCP server a role may be given (owner decision 2026-10-21: the full set for tester,
 * designer and researcher; `browser_evaluate`, `browser_run_code_unsafe` and `browser_file_upload` included). Roles list
 * `PLAYWRIGHT_TOOLS` in their `mcpTools`.
 */
export const PLAYWRIGHT_TOOLS: string[] = [
  BROWSER_NAVIGATE_TOOL,
  BROWSER_NAVIGATE_BACK_TOOL,
  BROWSER_TABS_TOOL,
  BROWSER_CLOSE_TOOL,
  BROWSER_RESIZE_TOOL,
  BROWSER_WAIT_FOR_TOOL,
  BROWSER_SNAPSHOT_TOOL,
  BROWSER_TAKE_SCREENSHOT_TOOL,
  BROWSER_FIND_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_HOVER_TOOL,
  BROWSER_DRAG_TOOL,
  BROWSER_DROP_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_PRESS_KEY_TOOL,
  BROWSER_FILL_FORM_TOOL,
  BROWSER_SELECT_OPTION_TOOL,
  BROWSER_FILE_UPLOAD_TOOL,
  BROWSER_HANDLE_DIALOG_TOOL,
  BROWSER_EMULATE_MEDIA_TOOL,
  BROWSER_EVALUATE_TOOL,
  BROWSER_RUN_CODE_UNSAFE_TOOL,
  BROWSER_CONSOLE_MESSAGES_TOOL,
  BROWSER_NETWORK_REQUESTS_TOOL,
  BROWSER_NETWORK_REQUEST_TOOL,
];
