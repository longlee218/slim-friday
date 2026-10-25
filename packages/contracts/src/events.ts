import { z } from "zod";
import {
  ApprovalAnswerSchema,
  ApprovalCardDtoSchema,
  QuestionAnswerDtoSchema,
  QuestionCardDtoSchema,
} from "./dto/cards";
import { MessageDtoSchema, RunStepDtoSchema } from "./dto/chat";
import { McpAuthStatusSchema } from "./dto/config";
import { BotStatusDtoSchema } from "./dto/status";
import { TicketDtoSchema } from "./dto/tickets";
import { ConversationIdSchema } from "./ids";

/**
 * Everything the server pushes to the web app (14 members). The numeric event id travels
 * as the SSE id, not inside the event.
 */
export const FridayEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    conversationId: ConversationIdSchema,
    message: MessageDtoSchema,
  }),
  z.object({
    type: z.literal("activity"),
    conversationId: ConversationIdSchema,
    botId: z.string(),
    kind: z.enum(["typing", "subagent"]),
    label: z.string().optional(),
  }),
  z.object({ type: z.literal("approval.opened"), card: ApprovalCardDtoSchema }),
  z.object({
    type: z.literal("approval.closed"),
    cardId: z.string(),
    // null = withdrawn by the engine, nobody answered
    answer: ApprovalAnswerSchema.nullable(),
  }),
  z.object({ type: z.literal("question.opened"), card: QuestionCardDtoSchema }),
  // null answer = timed out
  z.object({
    type: z.literal("question.closed"),
    cardId: z.string(),
    answer: QuestionAnswerDtoSchema.nullable(),
  }),
  z.object({
    type: z.literal("run"),
    conversationId: ConversationIdSchema,
    botId: z.string(),
    step: RunStepDtoSchema,
  }),
  z.object({
    type: z.literal("unread"),
    conversationId: ConversationIdSchema,
    unread: z.number().int().nonnegative(),
  }),
  // a run posted its final answer to the owner (live only; the web toasts it when that chat is not open)
  z.object({
    type: z.literal("run.finished"),
    conversationId: ConversationIdSchema,
    botId: z.string(),
    preview: z.string().max(400),
  }),
  // reserved: the v1 engine sends none, the web refetches control.status
  z.object({ type: z.literal("status"), bots: z.array(BotStatusDtoSchema) }),
  z.object({ type: z.literal("ticket"), ticket: TicketDtoSchema }),
  z.object({ type: z.literal("config.changed") }),
  // an OAuth MCP server's sign-in state changed (told on change only)
  z.object({ type: z.literal("mcp.auth"), server: z.string(), status: McpAuthStatusSchema }),
  // the client's lastEventId is older than the buffer: refetch everything
  z.object({ type: z.literal("resync") }),
]);
export type FridayEvent = z.infer<typeof FridayEventSchema>;
