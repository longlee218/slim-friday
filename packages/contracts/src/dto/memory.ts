import { z } from "zod";
import { MAX_RULE_CHARS } from "../limits";

/** Kinds of memory note. */
export const MemoryKindSchema = z.enum(["fact", "decision", "preference", "lesson"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

/** One note of `MEMORY.md`. */
export const MemoryNoteDtoSchema = z.object({
  id: z.string(),
  kind: MemoryKindSchema,
  text: z.string(),
  day: z.string().optional(),
});
export type MemoryNoteDto = z.infer<typeof MemoryNoteDtoSchema>;

/** One journal day with its items. */
export const JournalDayDtoSchema = z.object({ day: z.string(), items: z.array(z.string()) });
export type JournalDayDto = z.infer<typeof JournalDayDtoSchema>;

/** One line of `RULES.md`: a single-line rule that is on or off. */
export const RuleDtoSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(MAX_RULE_CHARS)
    .regex(/^[^\n\r]*$/),
  on: z.boolean(),
});
export type RuleDto = z.infer<typeof RuleDtoSchema>;
