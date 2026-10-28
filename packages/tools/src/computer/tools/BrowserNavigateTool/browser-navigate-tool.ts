import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { ComputerSession } from "../../computer-session";
import { BROWSER_NAVIGATE_TOOL } from "./constants";
import { BROWSER_NAVIGATE_DESCRIPTION } from "./prompt";

/** `BrowserNavigate` for one session. */
export function createBrowserNavigateTool(s: ComputerSession) {
  return tool(
    BROWSER_NAVIGATE_TOOL,
    BROWSER_NAVIGATE_DESCRIPTION,
    { url: z.string().min(1).describe("Absolute URL.") },
    (({ url }: { url: string }) =>
      s.run(async () => textResult(await s.ctx.browser.navigate(url)))) as never,
    { annotations: { openWorldHint: true } },
  );
}
