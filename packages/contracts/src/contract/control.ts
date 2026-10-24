import { z } from "zod";
import { BotStatusDtoSchema } from "../dto/status";
import { base } from "../errors";
import { BotIdSchema, ConversationIdSchema } from "../ids";

/** Run control: status, stop and trash purge. */
export const control = {
  status: base.output(z.array(BotStatusDtoSchema)),
  stop: base
    .input(
      z.object({ conversationId: ConversationIdSchema.optional(), botId: BotIdSchema.optional() }),
    )
    .output(z.object({ stopped: z.number().int() })),
  purge: base.output(z.object({ purged: z.number().int() })),
};
