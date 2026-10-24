import type { ApprovalCardDto, QuestionAnswerDto, QuestionCardDto } from "@friday/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { orpc } from "../api/client";
import { type Receipt, receiptsKey } from "./client-keys";

/** Adds a card to the pending list unless it is already there. */
export function openApproval(qc: QueryClient, card: ApprovalCardDto): void {
  qc.setQueryData<ApprovalCardDto[]>(orpc.approvals.pending.queryKey(), (l) =>
    l?.some((c) => c.cardId === card.cardId) ? l : [...(l ?? []), card],
  );
}

/** Adds a question card to the pending list unless it is already there. */
export function openQuestion(qc: QueryClient, card: QuestionCardDto): void {
  qc.setQueryData<QuestionCardDto[]>(orpc.questions.pending.queryKey(), (l) =>
    l?.some((c) => c.cardId === card.cardId) ? l : [...(l ?? []), card],
  );
}

/** Stores a receipt for a card (keyed by card id). */
function addReceipt(qc: QueryClient, cardId: string, receipt: Receipt): void {
  qc.setQueryData<Record<string, Receipt>>(receiptsKey(), (r) => ({ ...r, [cardId]: receipt }));
}

/** Moves an approval card from pending into receipts; unknown cards are ignored. */
export function closeApproval(
  qc: QueryClient,
  cardId: string,
  answer: "once" | "always" | "deny",
): void {
  const key = orpc.approvals.pending.queryKey();
  const card = qc.getQueryData<ApprovalCardDto[]>(key)?.find((c) => c.cardId === cardId);
  if (!card) return;
  qc.setQueryData<ApprovalCardDto[]>(key, (l) => l?.filter((c) => c.cardId !== cardId));
  addReceipt(qc, cardId, { kind: "approval", card, answer });
}

/** Moves a question card from pending into receipts (answer null = timed out). */
export function closeQuestion(
  qc: QueryClient,
  cardId: string,
  answer: QuestionAnswerDto | null,
): void {
  const key = orpc.questions.pending.queryKey();
  const card = qc.getQueryData<QuestionCardDto[]>(key)?.find((c) => c.cardId === cardId);
  if (!card) return;
  qc.setQueryData<QuestionCardDto[]>(key, (l) => l?.filter((c) => c.cardId !== cardId));
  addReceipt(qc, cardId, { kind: "question", card, answer });
}
