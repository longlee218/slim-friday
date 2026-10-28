import { z } from "zod";
import { ComputerStatusDtoSchema, ComputerViewDtoSchema } from "../dto/computer";
import { base } from "../errors";
import { BotIdSchema } from "../ids";

const BotInput = z.object({ botId: BotIdSchema });

/** The owner's view of a bot's computer: status, a live view, and taking control. */
export const computer = {
  status: base.input(BotInput).output(ComputerStatusDtoSchema),
  view: base
    .input(BotInput.extend({ mode: z.enum(["view", "control"]) }))
    .output(ComputerViewDtoSchema),
  takeControl: base.input(BotInput).output(z.object({ expiresAt: z.number() })),
  renewControl: base
    .input(BotInput)
    .output(z.object({ ok: z.boolean(), expiresAt: z.number().optional() })),
  closeView: base.input(BotInput).output(z.object({ ok: z.literal(true) })),
  giveBack: base.input(BotInput).output(z.object({ ok: z.literal(true) })),
};
