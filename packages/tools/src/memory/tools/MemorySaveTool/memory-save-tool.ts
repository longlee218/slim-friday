import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { bulletHash } from "../../bullet-hash";
import { type FileMemory, MemoryError, memoryErrorText } from "../../file-memory";
import { resolveOwner, type ToolSessionContext, visibleNotes } from "../../memory-owner";
import { sanitizeBullet } from "../../sanitize-bullet";
import { MEMORY_SAVE_MAX_CHARS, MEMORY_SAVE_TOOL } from "./constants";
import { MEMORY_SAVE_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  note: z
    .string()
    .min(1)
    .max(MEMORY_SAVE_MAX_CHARS)
    .describe("The note: one short plain sentence."),
  kind: z.enum(["decision", "fact", "preference", "lesson"]).optional().describe("Default fact."),
  scope: z.enum(["bot", "group"]).optional().describe("Default bot."),
};

/** `MemorySave` for one session. */
export function createMemorySaveTool(memory: FileMemory, ctx: ToolSessionContext) {
  return tool(
    MEMORY_SAVE_TOOL,
    MEMORY_SAVE_DESCRIPTION,
    SHAPE,
    async ({ note, kind, scope }) => {
      const owner = await resolveOwner(scope ?? "bot", ctx);
      if (typeof owner === "string") return textResult(owner, true);
      try {
        await memory.save(owner, note, kind);
        return textResult("saved");
      } catch (err) {
        // In a group session a copy of a hidden private note reads as saved (the note is stored), so the reply
        // cannot be used to test whether a private fact exists.
        if (
          err instanceof MemoryError &&
          err.code === "duplicate" &&
          owner.kind === "bot" &&
          ctx.groupId &&
          !visibleNotes(memory, owner, ctx).some((n) => n.id === bulletHash(sanitizeBullet(note)))
        )
          return textResult("saved");
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
