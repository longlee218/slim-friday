import type { ApprovalAnswer, ApprovalCard, ConversationId } from "@friday/core";
import type { ButtonSpec, DiscordPort, IncomingClick } from "./discord-port";

/** One card waiting for a click. */
interface OpenCard {
  channelId: string;
  messageId: string;
  text: string;
  settle: (a: ApprovalAnswer) => void;
}

/** What the card says after each answer. */
const OUTCOME: Record<ApprovalAnswer, string> = {
  once: "allowed once",
  always: "always allowed",
  deny: "denied",
};

/** Approval cards: a message with buttons per question; only the owner's click on an open card counts. */
export class ApprovalCards {
  /** Open cards by card number. */
  private open = new Map<number, OpenCard>();
  private counter = 0;

  constructor(private readonly port: DiscordPort) {
    port.onClick((c) => void this.click(c));
  }

  /** Post a card and wait for the owner's answer. A card that cannot be posted rejects. */
  async ask(channelId: ConversationId, card: ApprovalCard): Promise<ApprovalAnswer> {
    const n = ++this.counter;
    const buttons: ButtonSpec[] = [
      { id: `appr:${n}:once`, label: "Allow once", style: "primary" },
      ...(card.offerAlways
        ? [{ id: `appr:${n}:always`, label: "Always allow", style: "secondary" as const }]
        : []),
      { id: `appr:${n}:deny`, label: "Deny", style: "danger" },
    ];
    const text = `**${card.botName}** wants to run \`${card.summary}\``;
    const messageId = await this.port.sendButtons(channelId, text, buttons);
    return new Promise((settle) => this.open.set(n, { channelId, messageId, text, settle }));
  }

  /** Settle every open card as a deny (shutdown). */
  async cancelAll(note = "→ timed out"): Promise<void> {
    for (const [n, card] of [...this.open]) {
      this.open.delete(n);
      card.settle("deny");
      await this.port
        .editMessage(card.channelId, card.messageId, `${card.text}\n${note}`)
        .catch(() => {});
    }
  }

  /** A click: ack it; an owner's click on an open card of that channel settles it, anything else changes nothing. */
  private async click(c: IncomingClick): Promise<void> {
    await c.ack().catch(() => {});
    const m = /^appr:(\d+):(once|always|deny)$/.exec(c.customId);
    if (!m || c.userId !== this.port.ownerId) return;
    const n = Number(m[1]);
    const card = this.open.get(n);
    if (!card || card.channelId !== c.channelId) return;
    this.open.delete(n);
    const answer = m[2] as ApprovalAnswer;
    card.settle(answer);
    await this.port
      .editMessage(card.channelId, card.messageId, `${card.text}\n→ ${OUTCOME[answer]}`)
      .catch(() => {});
  }
}
