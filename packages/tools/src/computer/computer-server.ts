import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { COMPUTER_MCP_SERVER } from "../mcp-server-names";
import type { ComputerContext } from "./computer-context";
import { createComputerSession } from "./computer-session";
import { createBrowserActTool } from "./tools/BrowserActTool/browser-act-tool";
import { createBrowserNavigateTool } from "./tools/BrowserNavigateTool/browser-navigate-tool";
import { createBrowserSnapshotTool } from "./tools/BrowserSnapshotTool/browser-snapshot-tool";
import { createComputerActTool } from "./tools/ComputerActTool/computer-act-tool";
import { createComputerScreenshotTool } from "./tools/ComputerScreenshotTool/computer-screenshot-tool";
import { createComputerShellTool } from "./tools/ComputerShellTool/computer-shell-tool";

/** The `computer` server of one session; the slot hold lives in this closure (first call acquires, later calls renew). */
export function computerServer(ctx: ComputerContext) {
  const session = createComputerSession(ctx);
  return createSdkMcpServer({
    name: COMPUTER_MCP_SERVER,
    tools: [
      createComputerScreenshotTool(session),
      createComputerActTool(session),
      createComputerShellTool(session),
      createBrowserNavigateTool(session),
      createBrowserSnapshotTool(session),
      createBrowserActTool(session),
    ],
  });
}
