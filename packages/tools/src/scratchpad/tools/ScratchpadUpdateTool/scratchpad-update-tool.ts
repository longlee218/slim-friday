import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { fullError, itemView, limitError, type ScratchpadContext } from "../../scratchpad-context";
import { SCRATCHPAD_UPDATE_TOOL } from "./constants";
import { SCRATCHPAD_UPDATE_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  itemId: z.string().describe("The item's id."),
  title: z.string().optional(),
  status: z.enum(["open", "parked", "done"]).optional(),
  notes: z.string().optional(),
};

/** `ScratchpadUpdate` for one session scope. */
export function createScratchpadUpdateTool(ctx: ScratchpadContext) {
  return tool(
    SCRATCHPAD_UPDATE_TOOL,
    SCRATCHPAD_UPDATE_DESCRIPTION,
    SHAPE,
    async ({ itemId, title, status, notes }) => {
      const bad = limitError(title, notes);
      if (bad) return textResult(bad, true);
      const current = (await ctx.store.scratchpad.list(ctx.scopeKey)).find((i) => i.id === itemId);
      if (!current) return textResult(`No scratchpad item ${itemId}.`, true);
      // Bringing a done item back adds a live one: the cap applies.
      if (current.status === "done" && status && status !== "done") {
        const full = await fullError(ctx);
        if (full) return textResult(full, true);
      }
      const item = await ctx.store.scratchpad.update(
        itemId,
        ctx.scopeKey,
        {
          ...(title !== undefined && { title: title.trim() }),
          ...(status && { status }),
          ...(notes !== undefined && { notes }),
        },
        ctx.now(),
      );
      return item
        ? textResult(JSON.stringify(itemView(item)))
        : textResult(`No scratchpad item ${itemId}.`, true);
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  );
}
