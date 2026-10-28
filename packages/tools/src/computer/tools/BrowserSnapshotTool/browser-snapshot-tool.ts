import { tool } from "@anthropic-ai/claude-agent-sdk";
import { textResult } from "../../../tool-result";
import type { ComputerSession } from "../../computer-session";
import { BROWSER_SNAPSHOT_TOOL } from "./constants";
import { BROWSER_SNAPSHOT_DESCRIPTION } from "./prompt";

/** `BrowserSnapshot` for one session. */
export function createBrowserSnapshotTool(s: ComputerSession) {
  return tool(
    BROWSER_SNAPSHOT_TOOL,
    BROWSER_SNAPSHOT_DESCRIPTION,
    {},
    (() => s.run(async () => textResult(await s.ctx.browser.snapshot()))) as never,
    { annotations: { readOnlyHint: true } },
  );
}
