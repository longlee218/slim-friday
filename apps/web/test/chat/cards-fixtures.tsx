import type { ApprovalCardDto, QuestionCardDto } from "@friday/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { orpc } from "../../src/api/client";
import { chatClient } from "./fixtures";

/** A GitPush approval with two scope keys; the receipt line shows the second (`feat/x`). */
export const apprCard = (extra: Partial<ApprovalCardDto> = {}): ApprovalCardDto => ({
  cardId: "a1",
  conversationId: "bot:dev",
  botId: "dev",
  botName: "Dev",
  tool: "GitPush",
  summary: "Push the branch to origin.",
  scope: { repo: "friday", branch: "feat/x" },
  offerAlways: true,
  input: '{\n  "branch": "feat/x"\n}',
  ...extra,
});

export const askCard = (extra: Partial<QuestionCardDto> = {}): QuestionCardDto => ({
  cardId: "q1",
  conversationId: "bot:pia",
  botId: "pia",
  botName: "Pia",
  question: "Which format should the export use?",
  kind: "single",
  options: [
    { value: "csv", label: "CSV only", description: "Smallest and simplest" },
    { value: "number", label: "Invoice number" },
    { value: "customer", label: "Customer" },
  ],
  allowText: false,
  ...extra,
});

/** A client with the card in its pending list, so the mutation can fold it. */
export function cardClient(card: ApprovalCardDto | QuestionCardDto): QueryClient {
  const qc = chatClient();
  if ("tool" in card) qc.setQueryData(orpc.approvals.pending.queryKey(), [card]);
  else qc.setQueryData(orpc.questions.pending.queryKey(), [card]);
  return qc;
}
