import { z } from "zod";
import { ConversationIdSchema } from "../ids";

/** The owner's answer to an approval card. */
export const ApprovalAnswerSchema = z.enum(["once", "always", "deny"]);
export type ApprovalAnswer = z.infer<typeof ApprovalAnswerSchema>;

/** A tool-permission card waiting for the owner. */
export const ApprovalCardDtoSchema = z.object({
  cardId: z.string(),
  conversationId: ConversationIdSchema,
  botId: z.string(),
  botName: z.string(),
  tool: z.string(),
  summary: z.string(),
  scope: z.record(z.string(), z.string()),
  offerAlways: z.boolean(),
  /** The exact call a one-shot approval binds: the input as pretty JSON, cut when long. */
  input: z.string(),
  /** True when `input` is cut: the owner did not see the whole call, so the card can only be denied. */
  inputCut: z.boolean(),
});
export type ApprovalCardDto = z.infer<typeof ApprovalCardDtoSchema>;

/** One choice of a question card. */
export const QuestionOptionDtoSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type QuestionOptionDto = z.infer<typeof QuestionOptionDtoSchema>;

/** A question a bot asks the owner. */
export const QuestionCardDtoSchema = z.object({
  cardId: z.string(),
  conversationId: ConversationIdSchema,
  botId: z.string(),
  botName: z.string(),
  question: z.string(),
  kind: z.enum(["single", "multi", "confirm"]),
  options: z.array(QuestionOptionDtoSchema),
  allowText: z.boolean(),
});
export type QuestionCardDto = z.infer<typeof QuestionCardDtoSchema>;

/** The owner's answer to a question card. */
export const QuestionAnswerDtoSchema = z.object({
  choices: z.array(z.string()),
  text: z.string().optional(),
});
export type QuestionAnswerDto = z.infer<typeof QuestionAnswerDtoSchema>;
