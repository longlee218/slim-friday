import { z } from "zod";
import { SpendDtoSchema, WakeDtoSchema, WakeStatusSchema } from "../dto/ops";
import { BotStatusDtoSchema } from "../dto/status";
import { base } from "../errors";
import { DaySchema } from "../ids";

/** Operations views: sessions, wakes and spend. */
export const ops = {
  sessions: base.output(z.array(BotStatusDtoSchema)),
  wakes: base
    .input(z.object({ status: WakeStatusSchema.optional(), since: z.number().int() }))
    .output(z.array(WakeDtoSchema)),
  spend: base
    .input(z.object({ from: DaySchema, to: DaySchema }))
    .output(z.object({ rows: z.array(SpendDtoSchema), capPerBotPerDayUsd: z.number() })),
};
