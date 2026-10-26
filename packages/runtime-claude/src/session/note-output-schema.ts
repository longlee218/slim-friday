import type { OutputFormat } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/** Answer of the extraction call: the notes worth keeping, each for the bot or its group (the SDK needs an object at the root). */
export const ExtractedNotes = z.object({
  notes: z.array(z.object({ note: z.string(), about: z.enum(["bot", "group"]) })),
});

/** Answer of the consolidation call: the journal notes to promote, each under its MEMORY.md section. */
export const PromotedNotes = z.object({
  notes: z.array(
    z.object({
      kind: z.enum(["decision", "fact", "preference", "lesson"]),
      note: z.string(),
      /** Number of the memory note this one updates in place. */
      replaces: z.number().int().positive().optional(),
    }),
  ),
});

/**
 * SDK structured output for `schema`: the SDK checks the model's answer against it and asks again on a mismatch,
 * then hands the answer over as `structured_output`.
 */
export const jsonSchemaOutput = (schema: z.ZodType): OutputFormat => ({
  type: "json_schema",
  schema: z.toJSONSchema(schema, { target: "draft-7" }),
});

/** Turns a structured-output call may take: the answer plus up to two retries after a schema mismatch. */
export const STRUCTURED_MAX_TURNS = 3;
