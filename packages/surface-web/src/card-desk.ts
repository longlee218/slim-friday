import { randomUUID } from "node:crypto";
import type { ApprovalCardDto, QuestionCardDto } from "@friday/contracts";
import type {
  ApprovalAnswer,
  ApprovalCard,
  Clock,
  QuestionAnswer,
  QuestionCard,
} from "@friday/core";
import type { EventBus } from "./event-bus";

/** How many closed card ids are remembered, so a late answer is `conflict`, not `not_found`. */
const CLOSED_MEMORY = 500;
/** Longest summary shown on a card. */
const SUMMARY_MAX = 1200;

/** Result of answering a card. */
export type AnswerResult = "ok" | "conflict" | "not_found";

/** An open approval: its card, how to close it and how to stop its timer. */
interface OpenApproval {
  dto: ApprovalCardDto;
  settle: (a: ApprovalAnswer) => void;
}

/** An open question: its card, the original options and how to close it. */
interface OpenQuestion {
  dto: QuestionCardDto;
  settle: (a: QuestionAnswer | null) => void;
}

/**
 * Flatten a model-written summary (backticks and line breaks cannot fake the card) and cut it,
 * saying how much was cut. Same behavior as the retired Discord card (UTF-16 units).
 */
function flattenSummary(summary: string): string {
  const flat = summary.replace(/[`\r\n]+/g, " ");
  return flat.length > SUMMARY_MAX
    ? `${flat.slice(0, SUMMARY_MAX)} [CUT: ${flat.length - SUMMARY_MAX} more chars]`
    : flat;
}

/** Whether a question answer fits the card; the card stays open when it does not. */
function validAnswer(dto: QuestionCardDto, a: QuestionAnswer): boolean {
  const text = a.text?.trim();
  if (text && !dto.allowText) return false;
  if (a.choices.length === 0 && !text) return false;
  if (dto.kind !== "multi" && a.choices.length > 1) return false;
  const values = new Set(dto.options.map((o) => o.value));
  return a.choices.every((c) => values.has(c));
}

/**
 * Approval and question cards waiting for the owner on the web. Each card is published on the
 * event bus; the first answer wins, later ones are `conflict`. A timeout closes a card as
 * `deny` (approval) or `null` (question).
 */
export class CardDesk {
  /** Approvals not answered yet, by card id. */
  private approvals = new Map<string, OpenApproval>();
  /** Questions not answered yet, by card id. */
  private questions = new Map<string, OpenQuestion>();
  /** The last closed card ids, oldest first (a Set keeps insertion order). */
  private closed = new Set<string>();

  constructor(
    private bus: EventBus,
    private clock: Clock,
  ) {}

  /** Show an approval card; resolves with the first answer, or `deny` at the timeout. */
  askApproval(conversationId: string, card: ApprovalCard): Promise<ApprovalAnswer> {
    return new Promise((resolve) => {
      const cardId = randomUUID();
      const stop = this.startTimer(card.timeoutMs, () => this.closeApproval(cardId, "deny"));
      const dto: ApprovalCardDto = {
        cardId,
        conversationId,
        botId: card.botId ?? "",
        botName: card.botName,
        tool: card.tool,
        summary: flattenSummary(card.summary),
        scope: card.scope,
        offerAlways: card.offerAlways,
        ...(card.timeoutMs !== undefined && { expiresAt: this.clock.now() + card.timeoutMs }),
      };
      this.approvals.set(cardId, {
        dto,
        settle: (a) => {
          stop();
          resolve(a);
        },
      });
      this.bus.publish({ type: "approval.opened", card: dto });
    });
  }

  /** Show a question card; resolves with the first answer, or `null` at the timeout. */
  askQuestion(conversationId: string, card: QuestionCard): Promise<QuestionAnswer | null> {
    return new Promise((resolve) => {
      const cardId = randomUUID();
      const stop = this.startTimer(card.timeoutMs, () => this.closeQuestion(cardId, null));
      const dto: QuestionCardDto = {
        cardId,
        conversationId,
        botId: card.botId,
        botName: card.botName,
        question: card.question,
        kind: card.kind,
        options: card.options,
        allowText: card.allowText,
        ...(card.timeoutMs !== undefined && { expiresAt: this.clock.now() + card.timeoutMs }),
      };
      this.questions.set(cardId, {
        dto,
        settle: (a) => {
          stop();
          resolve(a);
        },
      });
      this.bus.publish({ type: "question.opened", card: dto });
    });
  }

  /** The owner answers an approval card. */
  answerApproval(cardId: string, answer: ApprovalAnswer): AnswerResult {
    if (!this.approvals.has(cardId)) return this.closed.has(cardId) ? "conflict" : "not_found";
    this.closeApproval(cardId, answer);
    return "ok";
  }

  /** The owner answers a question card; a bad answer leaves the card open. */
  answerQuestion(cardId: string, answer: QuestionAnswer): AnswerResult | "bad_answer" {
    const open = this.questions.get(cardId);
    if (!open) return this.closed.has(cardId) ? "conflict" : "not_found";
    if (!validAnswer(open.dto, answer)) return "bad_answer";
    this.closeQuestion(cardId, answer);
    return "ok";
  }

  /** Approval cards still open. */
  pendingApprovals(): ApprovalCardDto[] {
    return [...this.approvals.values()].map((o) => o.dto);
  }

  /** Question cards still open. */
  pendingQuestions(): QuestionCardDto[] {
    return [...this.questions.values()].map((o) => o.dto);
  }

  /** How many cards (both kinds) are open in one conversation. */
  openIn(conversationId: string): number {
    return (
      this.pendingApprovals().filter((c) => c.conversationId === conversationId).length +
      this.pendingQuestions().filter((c) => c.conversationId === conversationId).length
    );
  }

  /** Close every open card (shutdown): approvals `deny`, questions `null`. */
  cancelAll(): void {
    for (const id of [...this.approvals.keys()]) this.closeApproval(id, "deny");
    for (const id of [...this.questions.keys()]) this.closeQuestion(id, null);
  }

  /** Start a timer when the card has a timeout; returns its cancel function. */
  private startTimer(ms: number | undefined, fn: () => void): () => void {
    return ms === undefined ? () => {} : this.clock.setTimer(ms, fn);
  }

  /** Close an approval: settle the bot's wait, remember the id, tell the tabs. */
  private closeApproval(cardId: string, answer: ApprovalAnswer): void {
    const open = this.approvals.get(cardId);
    if (!open) return;
    this.approvals.delete(cardId);
    this.remember(cardId);
    open.settle(answer);
    this.bus.publish({ type: "approval.closed", cardId, answer });
  }

  /** Close a question: settle the bot's wait, remember the id, tell the tabs. */
  private closeQuestion(cardId: string, answer: QuestionAnswer | null): void {
    const open = this.questions.get(cardId);
    if (!open) return;
    this.questions.delete(cardId);
    this.remember(cardId);
    open.settle(answer);
    this.bus.publish({ type: "question.closed", cardId, answer });
  }

  /** Keep a closed id; forget the oldest beyond the limit. */
  private remember(cardId: string): void {
    this.closed.add(cardId);
    if (this.closed.size > CLOSED_MEMORY)
      this.closed.delete(this.closed.values().next().value as string);
  }
}
