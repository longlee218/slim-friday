import type { ApprovalAnswer, ApprovalCardDto, QuestionCardDto } from "@friday/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { client } from "../../api/client";
import { closeApproval, closeQuestion } from "../../events/apply-cards";

/** True for the API's "someone else answered first" error. */
const isConflict = (e: unknown): boolean => (e as { code?: string } | null)?.code === "CONFLICT";

/** Generic failure line: the card stays open so the owner can try again. */
const failed = () => toast("Could not send. Try again.");

/**
 * Answers an approval. Success folds the card into a receipt; `CONFLICT` (answered on
 * another device) folds it to "elsewhere" without an error toast; any other error keeps it open.
 */
export function useAnswerApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { card: ApprovalCardDto; answer: ApprovalAnswer }) =>
      client.approvals.answer({ cardId: v.card.cardId, answer: v.answer }),
    onSuccess: (_, v) => closeApproval(qc, v.card.cardId, v.answer, v.card),
    onError: (e, v) =>
      isConflict(e) ? closeApproval(qc, v.card.cardId, "elsewhere", v.card) : failed(),
  });
}

/** Answers a question card; same fold, conflict and error rules as `useAnswerApproval`. */
export function useAnswerQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { card: QuestionCardDto; choices: string[]; text?: string }) =>
      client.questions.answer({
        cardId: v.card.cardId,
        choices: v.choices,
        ...(v.text !== undefined && { text: v.text }),
      }),
    onSuccess: (_, v) =>
      closeQuestion(
        qc,
        v.card.cardId,
        { choices: v.choices, ...(v.text !== undefined && { text: v.text }) },
        v.card,
      ),
    onError: (e, v) =>
      isConflict(e) ? closeQuestion(qc, v.card.cardId, "elsewhere", v.card) : failed(),
  });
}
