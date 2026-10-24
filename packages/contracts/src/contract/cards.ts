import { z } from "zod";
import { ApprovalAnswerSchema, ApprovalCardDtoSchema, QuestionCardDtoSchema } from "../dto/cards";
import { OkDtoSchema } from "../dto/status";
import { base } from "../errors";

/** Approval cards waiting for the owner. */
export const approvals = {
  pending: base.output(z.array(ApprovalCardDtoSchema)),
  answer: base
    .input(z.object({ cardId: z.string(), answer: ApprovalAnswerSchema }))
    .output(OkDtoSchema),
};

/** Question cards waiting for the owner. */
export const questions = {
  pending: base.output(z.array(QuestionCardDtoSchema)),
  answer: base
    .input(
      z.object({
        cardId: z.string(),
        choices: z.array(z.string()).optional(),
        text: z.string().optional(),
      }),
    )
    .output(OkDtoSchema),
};
