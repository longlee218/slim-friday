import { z } from "zod";
import { ConversationDtoSchema, MessageDtoSchema } from "../dto/chat";
import { OkDtoSchema } from "../dto/status";
import { base } from "../errors";
import { ConversationIdSchema } from "../ids";
import { MAX_PAGE } from "../limits";

/** Conversation list, message history and read marks. */
export const conversations = {
  list: base.output(z.array(ConversationDtoSchema)),
  /** Newest first; `before` is the id of the oldest message already held. */
  messages: base
    .input(
      z.object({
        id: ConversationIdSchema,
        before: z.number().int().optional(),
        limit: z.number().int().min(1).max(MAX_PAGE).default(50),
      }),
    )
    .output(z.array(MessageDtoSchema)),
  markRead: base
    .input(z.object({ id: ConversationIdSchema, messageId: z.number().int() }))
    .output(OkDtoSchema),
};
