import { BROWSER_NAVIGATE_PAGE_TOOL } from "../mcp/browser/tools/BrowserNavigatePageTool/constants";
import { BROWSER_NEW_PAGE_TOOL } from "../mcp/browser/tools/BrowserNewPageTool/constants";
import { BROWSER_MCP_SERVER, mcpToolName } from "../mcp/mcp-tool-names";
import type { Decision } from "./check-tool-call";

/** Full names of the browser calls that open a URL. */
const URL_TOOLS = new Set([
  mcpToolName(BROWSER_MCP_SERVER, BROWSER_NAVIGATE_PAGE_TOOL),
  mcpToolName(BROWSER_MCP_SERVER, BROWSER_NEW_PAGE_TOOL),
]);

/** Schemes a browser call may open: the web and the blank page. `file:` would read any local file the server can read. */
const WEB_SCHEMES = new Set(["http:", "https:", "about:"]);

/**
 * Deny a browser navigate or new-page call whose `url` is not a web URL (`file:`, `chrome:`, `view-source:`, `data:`...).
 * The Chrome DevTools server runs outside the Bash OS sandbox, so this is its read bound next to the server's own
 * `--blockedUrlPattern`. A call without a `url` (back, forward, reload) passes. Undefined = not a browser URL call.
 */
export function checkBrowserUrl(
  toolName: string,
  input: Record<string, unknown>,
): Decision | undefined {
  if (!URL_TOOLS.has(toolName) || input.url === undefined) return undefined;
  let scheme: string | undefined;
  try {
    scheme = typeof input.url === "string" ? new URL(input.url).protocol : undefined;
  } catch {
    scheme = undefined;
  }
  return scheme && WEB_SCHEMES.has(scheme)
    ? undefined
    : { decision: "deny", reason: "browser: only http, https or about: URLs" };
}
