import { z } from "zod";
import {
  NotifyModeSchema,
  RepeatRuleSchema,
  ScheduleCreateInputSchema,
  ScheduleDtoSchema,
  ScheduleRunDtoSchema,
} from "../dto/schedules";
import { base } from "../errors";

const IdInput = z.object({ id: z.string() });

/** Scheduled runs: bots that work on their own on a clock. */
export const schedules = {
  list: base.input(z.object({})).output(z.object({ items: z.array(ScheduleDtoSchema) })),
  get: base.input(IdInput).output(z.object({ schedule: ScheduleDtoSchema })),
  /** Newest first, 20 per page; `before` is a run's `firedAt` from the previous page. */
  runs: base
    .input(z.object({ id: z.string(), before: z.number().optional() }))
    .output(z.object({ items: z.array(ScheduleRunDtoSchema), nextBefore: z.number().optional() })),
  create: base.input(ScheduleCreateInputSchema).output(ScheduleDtoSchema),
  update: base
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(80).optional(),
        task: z.string().min(1).max(4000).optional(),
        rule: RepeatRuleSchema.optional(),
        notify: NotifyModeSchema.optional(),
      }),
    )
    .output(ScheduleDtoSchema),
  setEnabled: base
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .output(ScheduleDtoSchema),
  /** `nonce` makes a double click one run. */
  runNow: base
    .input(z.object({ id: z.string(), nonce: z.string().min(1) }))
    .output(z.object({ wakeId: z.string() })),
  delete: base.input(IdInput).output(z.object({})),
};
