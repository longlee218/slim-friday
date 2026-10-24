import { z } from "zod";
import { UploadTicketDtoSchema } from "../dto/config";
import { base } from "../errors";
import { ConversationIdSchema } from "../ids";
import { MAX_FILES_PER_MESSAGE } from "../limits";

/** Sending messages and files. */
export const chat = {
  uploadCreate: base
    .input(
      z.object({
        conversationId: ConversationIdSchema,
        name: z.string().min(1).max(255),
        type: z.string(),
        size: z.number().int().positive(),
      }),
    )
    .output(UploadTicketDtoSchema),
  send: base
    .input(
      z.object({
        conversationId: ConversationIdSchema,
        text: z.string(),
        uploadIds: z.array(z.uuid()).max(MAX_FILES_PER_MESSAGE).optional(),
        replyTo: z.number().int().optional(),
        /** One per message, reused on a retry: a resend never stores a second message. */
        clientNonce: z.string().min(1).max(100).optional(),
      }),
    )
    .output(z.object({ messageId: z.number().int() })),
  file: base.input(z.object({ id: z.uuid() })).output(z.object({ url: z.string() })),
};
