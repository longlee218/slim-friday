import type { ApprovalCardDto, QuestionCardDto } from "@friday/contracts";
import type { ApprovalAnswer, CardRow, QuestionAnswer, Store } from "@friday/core";
import { inputCut, toApprovalDto, toQuestionDto } from "./card-dto";
import type { EventBus } from "./event-bus";

/**
 * The web's view of the open approval and question cards. The cards are rows in the engine db (the truth) and
 * every read goes to the db, so nothing is kept here: after a restart the stored open cards are listed again.
 * The engine shows a stored card (`open`) and closes it after the owner's answer went through the hub's
 * `answerCard` (`close`); each change is published on the event bus. No promise waits on a card and nothing
 * times out.
 */
export class CardDesk {
  /**
   * Display names of the bots that asked, learned from `open` (the app shows every stored open card at start,
   * so it is filled again after a restart). Bot names live in the config files, not in the db.
   */
  private names = new Map<string, string>();

  constructor(
    private bus: EventBus,
    private store: Pick<Store, "cards">,
  ) {}

  /** Publish a stored open card under the asking bot's name. */
  open(card: CardRow, botName: string): void {
    this.names.set(card.botId, botName);
    const approval = toApprovalDto(card, botName);
    if (approval) this.bus.publish({ type: "approval.opened", card: approval });
    const question = toQuestionDto(card, botName);
    if (question) this.bus.publish({ type: "question.opened", card: question });
  }

  /** Publish that a card was answered or withdrawn (a withdrawn card closes with no answer). */
  close(card: CardRow): void {
    if (card.kind === "approval")
      this.bus.publish({
        type: "approval.closed",
        cardId: card.id,
        answer: card.status === "withdrawn" ? null : ((card.answer as ApprovalAnswer) ?? null),
      });
    else
      this.bus.publish({
        type: "question.closed",
        cardId: card.id,
        answer: card.status === "withdrawn" ? null : ((card.answer as QuestionAnswer) ?? null),
      });
  }

  /** When an open card was created (epoch ms); undefined once it is not open or unknown. */
  async openedAt(cardId: string): Promise<number | undefined> {
    const card = await this.store.cards.get(cardId);
    return card?.status === "open" ? card.createdAt : undefined;
  }

  /** Whether an approval card shows less than its whole input (same check as the DTO's `inputCut`). */
  async inputCut(cardId: string): Promise<boolean> {
    const a = (await this.store.cards.get(cardId))?.approval;
    return a ? inputCut(a.input) : false;
  }

  /** Approval cards still open, from the db. */
  async pendingApprovals(): Promise<ApprovalCardDto[]> {
    const out: ApprovalCardDto[] = [];
    for (const card of await this.store.cards.open()) {
      const dto = toApprovalDto(card, this.botName(card));
      if (dto) out.push(dto);
    }
    return out;
  }

  /** Question cards still open, from the db. */
  async pendingQuestions(): Promise<QuestionCardDto[]> {
    const out: QuestionCardDto[] = [];
    for (const card of await this.store.cards.open()) {
      const dto = toQuestionDto(card, this.botName(card));
      if (dto) out.push(dto);
    }
    return out;
  }

  /** How many cards (both kinds) are open in one conversation. */
  async openIn(conversationId: string): Promise<number> {
    return (await this.store.cards.open()).filter((c) => c.conversationId === conversationId)
      .length;
  }

  /** The asking bot's display name: the last shown one, else the one stored on a question card, else its id. */
  private botName(card: CardRow): string {
    return this.names.get(card.botId) ?? card.question?.botName ?? card.botId;
  }
}
