import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { FileMemory } from "../../file-memory";
import { resolveOwner, type ToolSessionContext } from "../../memory-owner";
import { searchMemory } from "../../search-memory";
import { MEMORY_SEARCH_TOOL } from "./constants";
import { MEMORY_SEARCH_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  query: z.string().min(2).max(200).describe("A few words to look for."),
  scope: z.enum(["bot", "group"]).optional().describe("Default bot."),
};

/** `MemorySearch` for one session (read only). */
export function createMemorySearchTool(memory: FileMemory, ctx: ToolSessionContext) {
  return tool(
    MEMORY_SEARCH_TOOL,
    MEMORY_SEARCH_DESCRIPTION,
    SHAPE,
    async ({ query, scope }) => {
      const owner = await resolveOwner(scope ?? "bot", ctx);
      if (typeof owner === "string") return textResult(owner, true);
      const hits = searchMemory(memory.root, owner, query);
      return textResult(
        hits.length ? hits.map((h) => `[${h.source}] ${h.line}`).join("\n") : "no match",
      );
    },
    { annotations: { readOnlyHint: true } },
  );
}
