import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { FileMemory } from "../../file-memory";
import { resolveOwner, type ToolSessionContext, visibleNotes } from "../../memory-owner";
import type { MemoryRecall } from "../../recall/memory-recall";
import { MEMORY_SEARCH_TOOL } from "./constants";
import { MEMORY_SEARCH_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  query: z.string().min(2).max(200).describe("A few words to look for."),
  scope: z.enum(["bot", "group"]).optional().describe("Default bot."),
};

/**
 * `MemorySearch` for one session (read only). In a group session a bot-scope search keeps only hits that are visible
 * notes of the bot (`visibleNotes`; journal lines never), and nothing without `memory` to check against.
 */
export function createMemorySearchTool(
  recall: MemoryRecall,
  ctx: ToolSessionContext,
  memory?: Pick<FileMemory, "listBullets">,
) {
  return tool(
    MEMORY_SEARCH_TOOL,
    MEMORY_SEARCH_DESCRIPTION,
    SHAPE,
    async ({ query, scope }) => {
      const owner = await resolveOwner(scope ?? "bot", ctx);
      if (typeof owner === "string") return textResult(owner, true);
      let hits = await recall.search(owner, query);
      if (owner.kind === "bot" && ctx.groupId) {
        // A builtin hit names its note by id (`ref`); a provider hit carries the note text.
        const visible = memory ? visibleNotes(memory, owner, ctx) : [];
        const ids = new Set(visible.map((b) => b.id));
        const texts = new Set(visible.map((b) => b.text));
        hits = hits.filter((h) => (h.where === "memory" && ids.has(h.ref)) || texts.has(h.text));
      }
      return textResult(
        hits.length ? hits.map((h) => `[${h.where}] ${h.text}`).join("\n") : "no match",
      );
    },
    { annotations: { readOnlyHint: true } },
  );
}
