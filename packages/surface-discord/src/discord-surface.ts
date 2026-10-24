import type {
  Activity,
  ApprovalAnswer,
  ApprovalCard,
  BotId,
  ConversationId,
  InboundMessage,
  OutboundMessage,
  Surface,
} from "@friday/core";
import { ApprovalCards } from "./approval-cards";
import { type CommandHandler, registerCommands } from "./commands";
import type { ChannelTarget, DiscordPort } from "./discord-port";
import { splitText } from "./split-text";

/**
 * The core `Surface` on Discord. Every mapped channel is one conversation (channel id = conversation id);
 * only the owner's messages count. Bot posts go out through webhooks under the bot's own name.
 */
export class DiscordSurface implements Surface {
  /** Channel id to what it stands for (set by the channel sync). */
  private channels = new Map<string, ChannelTarget>();
  private readonly cards: ApprovalCards;

  constructor(
    protected readonly port: DiscordPort,
    /** Display name of a bot id (an unknown id is shown as is). */
    private readonly botName: (id: BotId) => string | undefined,
  ) {
    this.cards = new ApprovalCards(port);
  }

  /** Start accepting messages from a channel. */
  mapChannel(channelId: string, target: ChannelTarget): void {
    this.channels.set(channelId, target);
  }

  /** Stop accepting messages from a channel. */
  unmapChannel(channelId: string): void {
    this.channels.delete(channelId);
  }

  /** The owner's non-empty messages in mapped channels; bots, webhooks and everyone else are ignored. */
  onMessage(handler: (m: InboundMessage) => void): void {
    this.port.onMessage((m) => {
      if (m.authorId !== this.port.ownerId || m.fromBotOrWebhook) return;
      if (!this.channels.has(m.channelId) || !m.text.trim()) return;
      handler({ conversationId: m.channelId, text: m.text });
    });
  }

  /** Post a message; a long one is split into several, in order. */
  async post(conversationId: ConversationId, m: OutboundMessage): Promise<void> {
    for (const chunk of splitText(m.text)) {
      if (m.author.kind === "bot")
        await this.port.sendAs(
          conversationId,
          this.botName(m.author.botId) ?? m.author.botId,
          chunk,
        );
      else await this.port.send(conversationId, chunk);
    }
  }

  /** Typing indicator; a failure is not worth stopping for. */
  showActivity(conversationId: ConversationId, a: Activity): void {
    if (a.kind === "typing") this.port.typing(conversationId).catch(() => {});
  }

  /** Ask the owner with a card of buttons; resolves on their click. */
  askApproval(conversationId: ConversationId, card: ApprovalCard): Promise<ApprovalAnswer> {
    return this.cards.ask(conversationId, card);
  }

  /** Settle every open card as a deny (shutdown). */
  cancelApprovals(note?: string): Promise<void> {
    return this.cards.cancelAll(note);
  }

  /** Owner-only `/stop` and `/status`. */
  onCommand(handler: CommandHandler): void {
    registerCommands(this.port, handler);
  }
}
