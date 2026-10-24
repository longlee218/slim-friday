import { z } from "zod";

/** A bot id: lowercase, starts with a letter, at most 32 characters. */
export const BotIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type BotId = z.infer<typeof BotIdSchema>;

/** A conversation id: `bot:<id>` (direct) or `group:<id>`. */
export const ConversationIdSchema = z.string().regex(/^(bot|group):[a-z][a-z0-9-]{0,31}$/);
export type ConversationId = z.infer<typeof ConversationIdSchema>;

/** The owner of a memory: `bot:<id>` or `group:<id>` (same shape as a conversation id). */
export const MemoryOwnerSchema = z.string().regex(/^(bot|group):[a-z][a-z0-9-]{0,31}$/);
export type MemoryOwner = z.infer<typeof MemoryOwnerSchema>;

/** A ticket ref such as `FRI-3` (case-insensitive, no zero). */
export const TicketRefSchema = z.string().regex(/^FRI-[1-9]\d*$/i);
export type TicketRef = z.infer<typeof TicketRefSchema>;

/** A calendar day `YYYY-MM-DD`. */
export const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type Day = z.infer<typeof DaySchema>;
