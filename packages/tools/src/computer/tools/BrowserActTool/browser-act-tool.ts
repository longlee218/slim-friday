import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { PageStep } from "../../browser/page-act";
import { batchError, type ComputerSession } from "../../computer-session";
import { BROWSER_ACT_TOOL } from "./constants";
import { BROWSER_ACT_DESCRIPTION } from "./prompt";

/** One page step; matches `PageStep`. */
const STEP = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), ref: z.string().min(1) }),
  z.object({
    kind: z.literal("type"),
    ref: z.string().min(1),
    text: z.string(),
    submit: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("key"), keys: z.string().min(1) }),
  z.object({
    kind: z.literal("scroll"),
    dy: z.number().finite(),
    ref: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number().finite().nonnegative() }),
]);

/** `BrowserAct` for one session. */
export function createBrowserActTool(s: ComputerSession) {
  return tool(
    BROWSER_ACT_TOOL,
    BROWSER_ACT_DESCRIPTION,
    { steps: z.array(STEP).describe("1 to 20 steps, run in order.") },
    (({ steps }: { steps: PageStep[] }) => {
      const bad = batchError("steps", steps.length);
      if (bad) return Promise.resolve(textResult(bad, true));
      return s.runLeased(async (check) => {
        const out: string[] = [];
        for (const step of steps) {
          await check();
          out.push(await s.ctx.browser.act([step]));
        }
        return textResult(out.join("\n"));
      });
    }) as never,
    { annotations: { openWorldHint: true } },
  );
}
