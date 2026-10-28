import { z } from "zod";

/** Who holds the computer's input now (`bot` carries that bot's id). */
export const ComputerControlDtoSchema = z.object({
  holder: z.enum(["owner", "bot", "none"]),
  botId: z.string().optional(),
  expiresAt: z.number().optional(),
});
export type ComputerControlDto = z.infer<typeof ComputerControlDtoSchema>;

/** A bot's computer: whether it runs, the machine's slots and who controls the input. */
export const ComputerStatusDtoSchema = z.object({
  computer: z.string().optional(),
  running: z.boolean(),
  slots: z.object({ used: z.number().int(), limit: z.number().int(), text: z.string() }),
  control: ComputerControlDtoSchema,
});
export type ComputerStatusDto = z.infer<typeof ComputerStatusDtoSchema>;

/** A sealed viewer link: absolute when the API has a public base, else the `/computer-view/<token>/` path. */
export const ComputerViewDtoSchema = z.object({ url: z.string(), expiresAt: z.number() });
export type ComputerViewDto = z.infer<typeof ComputerViewDtoSchema>;
