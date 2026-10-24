import { z } from "zod";
import {
  TicketCommentDtoSchema,
  TicketDtoSchema,
  TicketPrioritySchema,
  TicketStatusSchema,
  TicketTimelineItemDtoSchema,
} from "../dto/tickets";
import { base } from "../errors";
import { BotIdSchema, TicketRefSchema } from "../ids";

/** The shared ticket board. */
export const tickets = {
  list: base
    .input(
      z.object({
        status: TicketStatusSchema.optional(),
        assignee: BotIdSchema.optional(),
        cursor: z.string().optional(),
      }),
    )
    .output(z.object({ items: z.array(TicketDtoSchema), nextCursor: z.string().optional() })),
  get: base.input(z.object({ ref: TicketRefSchema })).output(
    z.object({
      ticket: TicketDtoSchema,
      timeline: z.array(TicketTimelineItemDtoSchema),
      related: z.array(TicketDtoSchema),
    }),
  ),
  create: base
    .input(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().optional(),
        assignee: BotIdSchema.optional(),
        priority: TicketPrioritySchema.optional(),
      }),
    )
    .output(TicketDtoSchema),
  /** No unassign; `expectedUpdatedAt` guards against a stale write (CONFLICT). */
  update: base
    .input(
      z.object({
        ref: TicketRefSchema,
        status: TicketStatusSchema.optional(),
        assignee: BotIdSchema.optional(),
        priority: TicketPrioritySchema.optional(),
        description: z.string().optional(),
        blockedReason: z.string().optional(),
        expectedUpdatedAt: z.number().int(),
      }),
    )
    .output(TicketDtoSchema),
  comment: base
    .input(z.object({ ref: TicketRefSchema, text: z.string().min(1) }))
    .output(TicketCommentDtoSchema),
};
