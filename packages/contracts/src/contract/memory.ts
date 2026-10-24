import { z } from "zod";
import {
  JournalDayDtoSchema,
  MemoryKindSchema,
  MemoryNoteDtoSchema,
  RuleDtoSchema,
} from "../dto/memory";
import { OkDtoSchema } from "../dto/status";
import { base } from "../errors";
import { DaySchema, MemoryOwnerSchema } from "../ids";
import { MAX_RULES } from "../limits";

const owner = MemoryOwnerSchema;

/** Memory notes, journal and rules of a bot or group. */
export const memory = {
  list: base
    .input(z.object({ owner, kind: MemoryKindSchema.optional(), query: z.string().optional() }))
    .output(
      z.object({
        notes: z.array(MemoryNoteDtoSchema),
        promptChars: z.number().int(),
        capChars: z.number().int(),
      }),
    ),
  save: base
    .input(z.object({ owner, kind: MemoryKindSchema, text: z.string() }))
    .output(OkDtoSchema),
  edit: base.input(z.object({ owner, id: z.string(), text: z.string() })).output(OkDtoSchema),
  delete: base.input(z.object({ owner, id: z.string() })).output(OkDtoSchema),
  journal: base
    .input(z.object({ owner, day: DaySchema.optional() }))
    .output(z.array(JournalDayDtoSchema)),
  rules: {
    get: base.input(z.object({ owner })).output(z.array(RuleDtoSchema)),
    save: base
      .input(z.object({ owner, rules: z.array(RuleDtoSchema).max(MAX_RULES) }))
      .output(OkDtoSchema),
  },
};
