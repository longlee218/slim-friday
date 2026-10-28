import { z } from "zod";
import { AuthorDtoSchema } from "./chat";

/** Ticket states. */
export const TicketStatusSchema = z.enum(["todo", "doing", "review", "blocked", "done", "closed"]);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** Ticket priorities (core `TICKET_PRIORITIES`; the prototype's "medium" is `normal`). */
export const TicketPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;

/** One ticket on the shared board. */
export const TicketDtoSchema = z.object({
  id: z.string(),
  ref: z.string(),
  number: z.number().int(),
  title: z.string(),
  description: z.string().optional(),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  assigneeBotId: z.string().optional(),
  createdBy: AuthorDtoSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  conversationId: z.string().optional(),
  blockedReason: z.string().optional(),
  /** Refs this ticket waits on (done or not). */
  blockedBy: z.array(z.string()).optional(),
  /** Refs of the blockers not yet done or closed. */
  waitingOn: z.array(z.string()).optional(),
  commentCount: z.number().int().nonnegative(),
});
export type TicketDto = z.infer<typeof TicketDtoSchema>;

/** A comment on a ticket. */
export const TicketCommentDtoSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  author: AuthorDtoSchema,
  body: z.string(),
  createdAt: z.number(),
});
export type TicketCommentDto = z.infer<typeof TicketCommentDtoSchema>;

/** A change in a ticket's history. */
export const TicketEventDtoSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  kind: z.enum(["created", "status", "assignee", "priority", "handoff"]),
  from: z.string().optional(),
  to: z.string().optional(),
  actor: AuthorDtoSchema,
  at: z.number(),
});
export type TicketEventDto = z.infer<typeof TicketEventDtoSchema>;

/** One entry of the merged comment and event timeline. */
export const TicketTimelineItemDtoSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("comment"), comment: TicketCommentDtoSchema }),
  z.object({ type: z.literal("event"), event: TicketEventDtoSchema }),
]);
export type TicketTimelineItemDto = z.infer<typeof TicketTimelineItemDtoSchema>;
