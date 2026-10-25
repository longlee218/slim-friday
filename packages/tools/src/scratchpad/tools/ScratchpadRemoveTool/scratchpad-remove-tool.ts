import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { ScratchpadContext } from "../../scratchpad-context";
import { SCRATCHPAD_REMOVE_TOOL } from "./constants";
import { SCRATCHPAD_REMOVE_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = { itemId: z.string().describe("The item's id.") };

/** `ScratchpadRemove` for one session scope. */
export function createScratchpadRemoveTool(ctx: ScratchpadContext) {
  return tool(
    SCRATCHPAD_REMOVE_TOOL,
    SCRATCHPAD_REMOVE_DESCRIPTION,
    SHAPE,
    async ({ itemId }) =>
      (await ctx.store.scratchpad.remove(itemId, ctx.scopeKey))
        ? textResult(`Removed ${itemId}.`)
        : textResult(`No scratchpad item ${itemId}.`, true),
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  );
}
