import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { itemView, type ScratchpadContext } from "../../scratchpad-context";
import { SCRATCHPAD_COMPLETE_TOOL } from "./constants";
import { SCRATCHPAD_COMPLETE_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = { itemId: z.string().describe("The item's id.") };

/** `ScratchpadComplete` for one session scope. */
export function createScratchpadCompleteTool(ctx: ScratchpadContext) {
  return tool(
    SCRATCHPAD_COMPLETE_TOOL,
    SCRATCHPAD_COMPLETE_DESCRIPTION,
    SHAPE,
    async ({ itemId }) => {
      const item = await ctx.store.scratchpad.update(
        itemId,
        ctx.scopeKey,
        { status: "done" },
        ctx.now(),
      );
      return item
        ? textResult(JSON.stringify(itemView(item)))
        : textResult(`No scratchpad item ${itemId}.`, true);
    },
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );
}
