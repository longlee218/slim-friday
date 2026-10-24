import type { ApprovalCardDto, QuestionCardDto } from "@friday/contracts";
import type { ApprovalAnswer, CardRow, Clock, QuestionAnswer } from "@friday/core";
import type { EventBus } from "./event-bus";
import { flattenSummary } from "./flatten-summary";

/** An open card as the web shows it, with when it was shown (for the answer latency log). */
interface Shown<T> {
  dto: T;
  /** Epoch ms the card was shown. */
  openedAt: number;
}

/**
 * The web's view of the open approval and question cards. The cards are rows in the engine db (the truth): the
 * engine shows a stored card here (`open`), and closes it after the owner's answer went through the hub's
 * `answerCard` (`close`). Each change is published on the event bus. No promise waits on a card and nothing
 * times out; after a restart the app shows the stored open cards again. (Task 16 replaces this view with db reads.)
 */
export class CardDesk {
  /** Open approvals, by card id. */
  private approvals = new Map<string, Shown<ApprovalCardDto>>();
  /** Open questions, by card id. */
  private questions = new Map<string, Shown<QuestionCardDto>>();

  constructor(
    private bus: EventBus,
    private clock: Clock,
  ) {}

  /** Show a stored open card under the asking bot's name; showing the same card again changes nothing. */
  open(card: CardRow, botName: string): void {
    if (this.approvals.has(card.id) || this.questions.has(card.id)) return;
    const openedAt = this.clock.now();
    const base = {
      cardId: card.id,
      conversationId: card.conversationId,
      botId: card.botId,
      botName,
    };
    if (card.approval) {
      const a = card.approval;
      const dto: ApprovalCardDto = {
        ...base,
        tool: a.tool,
        summary: flattenSummary(a.summary),
        scope: a.scope,
        offerAlways: a.offerAlways,
      };
      this.approvals.set(card.id, { dto, openedAt });
      this.bus.publish({ type: "approval.opened", card: dto });
    } else if (card.question) {
      const q = card.question;
      const dto: QuestionCardDto = {
        ...base,
        question: q.question,
        kind: q.kind,
        options: q.options,
        allowText: q.allowText,
      };
      this.questions.set(card.id, { dto, openedAt });
      this.bus.publish({ type: "question.opened", card: dto });
    }
  }

  /** Close a card that was answered or withdrawn (a withdrawn question closes with no answer). */
  close(card: CardRow): void {
    if (this.approvals.delete(card.id))
      this.bus.publish({
        type: "approval.closed",
        cardId: card.id,
        answer: (card.answer as ApprovalAnswer | undefined) ?? "deny",
      });
    else if (this.questions.delete(card.id))
      this.bus.publish({
        type: "question.closed",
        cardId: card.id,
        answer: card.status === "withdrawn" ? null : ((card.answer as QuestionAnswer) ?? null),
      });
  }

  /** When an open card (either kind) was shown; undefined once closed or unknown. */
  openedAt(cardId: string): number | undefined {
    return (this.approvals.get(cardId) ?? this.questions.get(cardId))?.openedAt;
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
}
