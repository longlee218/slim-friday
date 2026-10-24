import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { resolveOwner, type ToolSessionContext } from "../../memory-owner";
import type { MemoryRecall } from "../../recall/memory-recall";
import { MEMORY_SEARCH_TOOL } from "./constants";
import { MEMORY_SEARCH_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  query: z.string().min(2).max(200).describe("A few words to look for."),
  scope: z.enum(["bot", "group"]).optional().describe("Default bot."),
};

/** `MemorySearch` for one session (read only). */
export function createMemorySearchTool(recall: MemoryRecall, ctx: ToolSessionContext) {
  return tool(
    MEMORY_SEARCH_TOOL,
    MEMORY_SEARCH_DESCRIPTION,
    SHAPE,
    async ({ query, scope }) => {
      const owner = await resolveOwner(scope ?? "bot", ctx);
      if (typeof owner === "string") return textResult(owner, true);
      const hits = await recall.search(owner, query);
      return textResult(
        hits.length ? hits.map((h) => `[${h.where}] ${h.text}`).join("\n") : "no match",
      );
    },
    { annotations: { readOnlyHint: true } },
  );
}
