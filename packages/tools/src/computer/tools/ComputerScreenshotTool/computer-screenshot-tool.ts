import { tool } from "@anthropic-ai/claude-agent-sdk";
import { textResult } from "../../../tool-result";
import type { ComputerSession } from "../../computer-session";
import { COMPUTER_SCREENSHOT_TOOL } from "./constants";
import { COMPUTER_SCREENSHOT_DESCRIPTION } from "./prompt";

/** Text returned when the picture equals the previous one. */
const UNCHANGED = "Screen unchanged since the last screenshot.";

/** True when both byte arrays hold the same bytes. */
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** `ComputerScreenshot` for one session. */
export function createComputerScreenshotTool(s: ComputerSession) {
  return tool(
    COMPUTER_SCREENSHOT_TOOL,
    COMPUTER_SCREENSHOT_DESCRIPTION,
    {},
    () =>
      s.run(async () => {
        const shot = await s.ctx.provider.screenshot(s.ctx.computer.name);
        const same = s.lastPng !== undefined && sameBytes(s.lastPng, shot.png);
        s.lastPng = shot.png;
        if (same) return textResult(UNCHANGED);
        return {
          content: [
            {
              type: "image" as const,
              data: Buffer.from(shot.png).toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      }) as never,
    { annotations: { readOnlyHint: true } },
  );
}
