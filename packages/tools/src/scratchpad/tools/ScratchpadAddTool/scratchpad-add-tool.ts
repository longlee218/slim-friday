import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { fullError, itemView, limitError, type ScratchpadContext } from "../../scratchpad-context";
import { SCRATCHPAD_ADD_TOOL } from "./constants";
import { SCRATCHPAD_ADD_DESCRIPTION } from "./prompt";

/** Input the model sees (the limits are checked in the handler, so the refusal is readable). */
const SHAPE = {
  title: z.string().describe("Short title for the item."),
  status: z.enum(["open", "parked", "done"]).optional().describe("Defaults to open."),
  notes: z.string().optional().describe("Details to keep with the item."),
};

/** `ScratchpadAdd` for one session scope. */
export function createScratchpadAddTool(ctx: ScratchpadContext) {
  return tool(
    SCRATCHPAD_ADD_TOOL,
    SCRATCHPAD_ADD_DESCRIPTION,
    SHAPE,
    async ({ title, status, notes }) => {
      const bad = limitError(title, notes);
      if (bad) return textResult(bad, true);
      const st = status ?? "open";
      if (st !== "done") {
        const full = await fullError(ctx);
        if (full) return textResult(full, true);
      }
      const item = await ctx.store.scratchpad.add(
        {
          scopeKey: ctx.scopeKey,
          botId: ctx.botId,
          title: title.trim(),
          status: st,
          notes: notes ?? "",
        },
        ctx.now(),
      );
      return textResult(JSON.stringify(itemView(item)));
    },
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      alwaysLoad: true,
    },
  );
}
