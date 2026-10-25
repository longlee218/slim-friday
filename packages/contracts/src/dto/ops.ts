import { z } from "zod";
import { AuthorDtoSchema } from "./chat";

/** Wake states (a wake is also a stored run: leased, waiting on a card, failed or cancelled). */
export const WakeStatusSchema = z.enum([
  "queued",
  "running",
  "done",
  "blocked",
  "interrupted",
  "expired",
  "dropped",
  "leased",
  "waiting_input",
  "failed",
  "cancelled",
]);
export type WakeStatus = z.infer<typeof WakeStatusSchema>;

/** One wake of a bot (metadata only, no text). */
export const WakeDtoSchema = z.object({
  id: z.string(),
  chainId: z.string(),
  conversationId: z.string(),
  targetBot: z.string(),
  sender: AuthorDtoSchema,
  intent: z.enum(["request", "question", "result", "status", "fyi"]),
  hop: z.number().int(),
  status: WakeStatusSchema,
  blockReason: z.enum(["hops", "rate", "repeat", "spend"]).optional(),
  attempts: z.number().int(),
  ticketId: z.string().optional(),
  handoff: z.boolean().optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  firstTextAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type WakeDto = z.infer<typeof WakeDtoSchema>;

/** Spend of one bot on one day, in USD. */
export const SpendDtoSchema = z.object({ botId: z.string(), day: z.string(), usd: z.number() });
export type SpendDto = z.infer<typeof SpendDtoSchema>;
