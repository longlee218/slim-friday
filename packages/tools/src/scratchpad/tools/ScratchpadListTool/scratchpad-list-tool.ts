import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { itemView, type ScratchpadContext } from "../../scratchpad-context";
import { SCRATCHPAD_LIST_TOOL } from "./constants";
import { SCRATCHPAD_LIST_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  includeDone: z.boolean().optional().describe("When true, include completed items."),
};

/** `ScratchpadList` for one session scope. */
export function createScratchpadListTool(ctx: ScratchpadContext) {
  return tool(
    SCRATCHPAD_LIST_TOOL,
    SCRATCHPAD_LIST_DESCRIPTION,
    SHAPE,
    async ({ includeDone }) => {
      const items = await ctx.store.scratchpad.list(ctx.scopeKey);
      const shown = items.filter((i) => includeDone || i.status !== "done");
      return textResult(shown.length === 0 ? "No items." : JSON.stringify(shown.map(itemView)));
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  );
}
