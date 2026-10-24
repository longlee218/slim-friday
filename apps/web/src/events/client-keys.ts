import type {
  ApprovalCardDto,
  QuestionAnswerDto,
  QuestionCardDto,
  RunStepDto,
} from "@friday/contracts";

/** A bot's run in progress in one conversation (client-only state). */
export interface LiveRun {
  botId: string;
  startedAt: number;
  steps: RunStepDto[];
  /** Label of the latest subagent activity. */
  tail?: string;
}

/** A closed card kept in the transcript as a receipt. */
export type Receipt =
  | { kind: "approval"; card: ApprovalCardDto; answer: "once" | "always" | "deny" | "elsewhere" }
  | {
      kind: "question";
      card: QuestionCardDto;
      answer: QuestionAnswerDto | null | "elsewhere";
      labels?: string;
    };

/** Cache key of the live runs of a conversation: `Record<botId, LiveRun>`. */
export const liveRunKey = (conversationId: string) => ["web", "liveRun", conversationId] as const;

/** Cache key of the receipts: `Record<cardId, Receipt>`. */
export const receiptsKey = () => ["web", "receipts"] as const;
