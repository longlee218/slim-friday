import type { ApprovalAnswer } from "../ports/surface";
import type { BotId } from "./bot";
import type { ConversationId } from "./conversation";
import type { QuestionAnswer, QuestionCard } from "./question";

/** An approval or a question a run put to the owner; it outlives the process that asked. */
export interface CardRow {
  id: string;
  kind: "approval" | "question";
  /** The run waiting for the answer. */
  wakeId: string;
  botId: BotId;
  conversationId: ConversationId;
  scopeKey: string;
  /** Set for approval cards. */
  approval?: {
    tool: string;
    input: Record<string, unknown>;
    inputHash: string;
    summary: string;
    scope: Record<string, string>;
    /** Whether the owner may pick "always". */
    offerAlways: boolean;
  };
  /** Set for question cards. */
  question?: QuestionCard;
  status: "open" | "answered" | "withdrawn" | "used";
  answer?: ApprovalAnswer | QuestionAnswer;
  /** Epoch milliseconds. */
  createdAt: number;
  answeredAt?: number;
  remindedAt?: number;
}
