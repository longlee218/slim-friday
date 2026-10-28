import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { DesktopAction } from "@friday/core";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { batchError, type ComputerSession } from "../../computer-session";
import { COMPUTER_ACT_TOOL } from "./constants";
import { COMPUTER_ACT_DESCRIPTION } from "./prompt";

const num = z.number().finite();

/** One desktop input; matches `DesktopAction` of core. */
const ACTION = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    x: num,
    y: num,
    button: z.enum(["left", "right"]).optional(),
    double: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("type"), text: z.string().min(1) }),
  z.object({ kind: z.literal("key"), keys: z.string().min(1) }),
  z.object({ kind: z.literal("scroll"), x: num, y: num, dx: num, dy: num }),
  z.object({
    kind: z.literal("drag"),
    fromX: num,
    fromY: num,
    toX: num,
    toY: num,
  }),
  z.object({ kind: z.literal("wait"), ms: num.nonnegative() }),
]);

/** `ComputerAct` for one session. */
export function createComputerActTool(s: ComputerSession) {
  return tool(
    COMPUTER_ACT_TOOL,
    COMPUTER_ACT_DESCRIPTION,
    { actions: z.array(ACTION).describe("1 to 20 actions, run in order.") },
    (({ actions }: { actions: DesktopAction[] }) => {
      const bad = batchError("actions", actions.length);
      if (bad) return Promise.resolve(textResult(bad, true));
      return s.runLeased(async (check) => {
        let done = 0;
        try {
          for (const action of actions) {
            await check();
            await s.ctx.provider.act(s.ctx.computer.name, action);
            done++;
          }
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          return textResult(`${why} after ${done} of ${actions.length} actions`, true);
        }
        return textResult(`Ran ${done} action(s).`);
      });
    }) as never,
    { annotations: { openWorldHint: true } },
  );
}
