import type { ApprovalAnswer, ApprovalCard, ConversationId } from "@friday/core";
import type { ButtonSpec, DiscordPort, IncomingClick } from "./discord-port";

/** One card waiting for a click. */
interface OpenCard {
  channelId: string;
  messageId: string;
  text: string;
  settle: (a: ApprovalAnswer) => void;
  /** Ends the timeout timer. */
  stopTimer: () => void;
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
  /** Random per process: a button left from before a restart never matches a new card. */
  private readonly nonce = crypto.randomUUID().slice(0, 8);

  constructor(private readonly port: DiscordPort) {
    port.onClick((c) => void this.click(c));
  }

  /** Post a card and wait for the owner's answer. A card that cannot be posted rejects. */
  async ask(channelId: ConversationId, card: ApprovalCard): Promise<ApprovalAnswer> {
    const n = ++this.counter;
    const buttons: ButtonSpec[] = [
      { id: `appr:${this.nonce}:${n}:once`, label: "Allow once", style: "primary" },
      ...(card.offerAlways
        ? [
            {
              id: `appr:${this.nonce}:${n}:always`,
              label: "Always allow",
              style: "secondary" as const,
            },
          ]
        : []),
      { id: `appr:${this.nonce}:${n}:deny`, label: "Deny", style: "danger" },
    ];
    // The summary comes from the model: flatten backticks and line breaks so it cannot fake the card or its outcome.
    const summary = card.summary.replace(/[`\r\n]+/g, " ").slice(0, 1200);
    const text = `**${card.botName}** wants to run \`${summary}\``;
    const messageId = await this.port.sendButtons(channelId, text, buttons);
    return new Promise((settle) => {
      // The gate has denied by then; close the card so a late click cannot show a false answer.
      const timer = card.timeoutMs
        ? setTimeout(() => {
            if (!this.open.delete(n)) return;
            settle("deny");
            void this.port
              .editMessage(channelId, messageId, `${text}\n→ timed out`)
              .catch(() => {});
          }, card.timeoutMs)
        : undefined;
      const stopTimer = () => clearTimeout(timer);
      this.open.set(n, { channelId, messageId, text, settle, stopTimer });
    });
  }

  /** Settle every open card as a deny (shutdown). */
  async cancelAll(note = "→ timed out"): Promise<void> {
    for (const [n, card] of [...this.open]) {
      this.open.delete(n);
      card.stopTimer();
      card.settle("deny");
      await this.port
        .editMessage(card.channelId, card.messageId, `${card.text}\n${note}`)
        .catch(() => {});
    }
  }

  /** A click: ack it; an owner's click on an open card of that channel settles it, anything else changes nothing. */
  private async click(c: IncomingClick): Promise<void> {
    await c.ack().catch(() => {});
    const m = /^appr:([0-9a-f]{8}):(\d+):(once|always|deny)$/.exec(c.customId);
    if (!m || c.userId !== this.port.ownerId) return;
    if (m[1] !== this.nonce) return;
    const n = Number(m[2]);
    const card = this.open.get(n);
    if (!card || card.channelId !== c.channelId) return;
    this.open.delete(n);
    card.stopTimer();
    const answer = m[3] as ApprovalAnswer;
    card.settle(answer);
    await this.port
      .editMessage(card.channelId, card.messageId, `${card.text}\n→ ${OUTCOME[answer]}`)
      .catch(() => {});
  }
}
