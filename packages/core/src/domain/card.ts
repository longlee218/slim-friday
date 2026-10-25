import type { ApprovalAnswer } from "../ports/surface";
import type { BotId } from "./bot";
import type { ConversationId } from "./conversation";
import type { RuleMatch } from "./grant";
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
    /**
     * The rule "always" stores when it is not a `tool` rule for `tool` with `scope`: a `WebFetch` card stores a
     * `site` rule for the url's registrable domain (spec §6.14). Unset: the `tool` rule.
     */
    always?: { match: Exclude<RuleMatch, "tool">; value: string };
    /** The call was asked while its run was tainted (spec §6.10); unset: asked in a clean run. */
    tainted?: boolean;
  };
  /** Set for question cards. */
  question?: QuestionCard;
  status: "open" | "answered" | "withdrawn" | "used";
  answer?: ApprovalAnswer | QuestionAnswer;
  /** Epoch milliseconds. */
  createdAt: number;
  answeredAt?: number;
  remindedAt?: number;
  /** The owner message whose typed text answered the card (a resend of it must not answer twice). */
  answeredMessageId?: number;
}
