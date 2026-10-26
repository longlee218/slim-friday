import { z } from "zod";

/** What one bot is doing now. `startedAt` = its oldest open session (epoch ms). */
export const BotStatusDtoSchema = z.object({
  botId: z.string(),
  name: z.string(),
  working: z.boolean(),
  label: z.string().optional(),
  tasks: z.array(z.object({ id: z.string(), description: z.string() })),
  spendToday: z.number(),
  startedAt: z.number().optional(),
});
export type BotStatusDto = z.infer<typeof BotStatusDtoSchema>;

/** A tool the file skills need that is not installed, with how to install it. */
export const ToolWarningDtoSchema = z.object({ tool: z.string(), hint: z.string() });
export type ToolWarningDto = z.infer<typeof ToolWarningDtoSchema>;

/** The result of a call that returns nothing else. */
export const OkDtoSchema = z.object({ ok: z.literal(true) });
export type OkDto = z.infer<typeof OkDtoSchema>;
