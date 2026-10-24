import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { type FileMemory, MemoryError, memoryErrorText } from "../../file-memory";
import { resolveOwner, type ToolSessionContext } from "../../memory-owner";
import { MEMORY_SAVE_MAX_CHARS } from "../MemorySaveTool/constants";
import { MEMORY_EDIT_TOOL } from "./constants";
import { MEMORY_EDIT_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  id: z.string().optional().describe("Note id from the list; leave out to list the notes."),
  text: z.string().max(MEMORY_SAVE_MAX_CHARS).optional().describe("New text of the note."),
  delete: z.boolean().optional().describe("true = remove the note."),
  scope: z.enum(["bot", "group"]).optional().describe("Default bot."),
};

/** `MemoryEdit` for one session. */
export function createMemoryEditTool(memory: FileMemory, ctx: ToolSessionContext) {
  return tool(
    MEMORY_EDIT_TOOL,
    MEMORY_EDIT_DESCRIPTION,
    SHAPE,
    async ({ id, text, delete: remove, scope }) => {
      const owner = await resolveOwner(scope ?? "bot", ctx);
      if (typeof owner === "string") return textResult(owner, true);
      if (!id) {
        const notes = memory.listBullets(owner);
        return textResult(
          notes.length
            ? notes.map((n) => `[${n.id}] (${n.kind}) ${n.text}`).join("\n")
            : "no notes",
        );
      }
      if (!remove && text === undefined) return textResult("give text or delete: true", true);
      try {
        await memory.edit(owner, id, remove ? null : (text ?? ""));
        return textResult(remove ? "deleted" : "replaced");
      } catch (err) {
        if (err instanceof MemoryError) return textResult(memoryErrorText(err), true);
        throw err;
      }
    },
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
