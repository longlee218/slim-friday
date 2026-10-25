import type {
  Activity,
  Author,
  BotId,
  CardRow,
  ConversationId,
  InboundMessage,
  OutboundMessage,
  RunStep,
  Surface,
} from "../../src";

/** A Surface that records what the engine does and lets the test play the user. */
export class FakeSurface implements Surface {
  posts: { conversationId: ConversationId; message: OutboundMessage }[] = [];
  activities: { conversationId: ConversationId; activity: Activity }[] = [];
  /** Cards shown, in order, with the bot name they were shown under. */
  shown: { card: CardRow; botName: string }[] = [];
  /** Cards closed, in order (answered or withdrawn). */
  closed: CardRow[] = [];
  runs: { conversationId: ConversationId; botId: BotId; step: RunStep }[] = [];
  private handler: (m: InboundMessage) => Promise<number | undefined> = async () => undefined;

  onMessage(handler: (m: InboundMessage) => Promise<number | undefined>): void {
    this.handler = handler;
  }
  async post(conversationId: ConversationId, message: OutboundMessage): Promise<void> {
    this.posts.push({ conversationId, message });
  }
  showCard(card: CardRow, botName: string): void {
    this.shown.push({ card, botName });
  }
  closeCard(card: CardRow): void {
    this.closed.push(card);
  }
  files: { conversationId: ConversationId; author: Author; name: string; caption?: string }[] = [];
  async postFile(
    conversationId: ConversationId,
    author: Author,
    file: { path: string; name: string },
    caption?: string,
  ): Promise<void> {
    this.files.push({ conversationId, author, name: file.name, ...(caption && { caption }) });
  }
  /** Finished notices, in order. */
  finished: { conversationId: ConversationId; botId: BotId; preview: string }[] = [];
  notifyFinished(e: { conversationId: ConversationId; botId: BotId; preview: string }): void {
    this.finished.push(e);
  }
  showRun(conversationId: ConversationId, botId: BotId, step: RunStep): void {
    this.runs.push({ conversationId, botId, step });
  }
  showActivity(conversationId: ConversationId, activity: Activity): void {
    this.activities.push({ conversationId, activity });
  }

  /** The user sends a message. */
  deliver(m: InboundMessage): Promise<number | undefined> {
    return this.handler(m);
  }
}
