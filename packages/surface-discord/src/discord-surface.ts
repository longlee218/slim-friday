import { join } from "node:path";
import type {
  Activity,
  ApprovalAnswer,
  ApprovalCard,
  Author,
  BotId,
  ConversationId,
  InboundMessage,
  OutboundMessage,
  Surface,
} from "@friday/core";
import { ApprovalCards } from "./approval-cards";
import { type CommandHandler, registerCommands } from "./commands";
import type { ChannelTarget, DiscordPort, IncomingMessage } from "./discord-port";
import { downloadAttachments, type FetchFn } from "./download-attachments";
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
    /** Where the owner's files are saved (`<inboxDir>/<channel>/<epoch>/`); without it files are ignored. */
    private readonly files?: { inboxDir: string; now: () => number; fetchFn?: FetchFn },
    /** Avatar image file of a bot (none = the default avatar). */
    private readonly avatarOf?: (id: BotId) => string | undefined,
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

  /**
   * The owner's messages in mapped channels with text or files; bots, webhooks and everyone else are ignored
   * (and their files are never downloaded). Files are saved first; a refused one is named in a system reply.
   */
  onMessage(handler: (m: InboundMessage) => void): void {
    this.port.onMessage((m) => {
      if (m.authorId !== this.port.ownerId || m.fromBotOrWebhook) return;
      if (!this.channels.has(m.channelId)) return;
      const hasFiles = !!this.files && !!m.attachments?.length;
      if (!m.text.trim() && !hasFiles) return;
      if (!hasFiles) return handler({ conversationId: m.channelId, text: m.text });
      this.deliverWithFiles(m, handler).catch(() => {});
    });
  }

  /** Download the files of `m`, then hand the message over with the saved ones. */
  private async deliverWithFiles(
    m: IncomingMessage,
    handler: (m: InboundMessage) => void,
  ): Promise<void> {
    const dir = join(this.files?.inboxDir ?? "", m.channelId, String(this.files?.now()));
    const { saved, refused } = await downloadAttachments(
      m.attachments ?? [],
      dir,
      this.files?.fetchFn,
    );
    if (refused.length)
      await this.port.send(m.channelId, `Files not taken: ${refused.join("; ")}`).catch(() => {});
    const text = m.text.trim() || (saved.length ? `(sent ${saved.length} file(s))` : "");
    if (!text) return;
    handler({
      conversationId: m.channelId,
      text: m.text.trim() ? m.text : text,
      ...(saved.length && { attachments: saved }),
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
          this.avatarOf?.(m.author.botId),
        );
      else await this.port.send(conversationId, chunk);
    }
  }

  /** Send a file under the author's name (a bot's display name, or "Friday" for the app). */
  async postFile(
    conversationId: ConversationId,
    author: Author,
    file: { path: string; name: string },
    caption?: string,
  ): Promise<void> {
    const name = author.kind === "bot" ? (this.botName(author.botId) ?? author.botId) : "Friday";
    await this.port.sendFileAs(
      conversationId,
      name,
      file,
      caption,
      author.kind === "bot" ? this.avatarOf?.(author.botId) : undefined,
    );
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
