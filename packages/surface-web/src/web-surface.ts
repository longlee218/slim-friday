import type {
  Activity,
  ApprovalAnswer,
  ApprovalCard,
  Author,
  Clock,
  ConversationId,
  FileStore,
  InboundMessage,
  Log,
  OutboundMessage,
  QuestionAnswer,
  QuestionCard,
  RunStep,
  Store,
  Surface,
} from "@friday/core";
import { CardDesk } from "./card-desk";
import { EventBus } from "./event-bus";
import { createUpload, sendOwnerMessage } from "./inbound";
import { toMessageDto } from "./message-dto";
import { postBotFile } from "./post-bot-file";

/** Replay buffer size of the event bus (spec: 500 events). */
const REPLAY_EVENTS = 500;

/** What the web surface needs from the engine. */
export interface WebSurfaceDeps {
  store: Pick<Store, "conversations" | "messages" | "files" | "uploads" | "reads">;
  files: FileStore;
  clock: Clock;
  /** Directory for files from the owner (used by the inbound side). */
  inboxDir: string;
  log?: Log;
}

/** The core `Surface` for the web app: everything outbound becomes an event on the bus. */
export class WebSurface implements Surface {
  readonly bus = new EventBus(REPLAY_EVENTS);
  readonly cards: CardDesk;
  /** The inbound handler; the inbound side (owner messages) calls it. */
  protected handler?: (m: InboundMessage) => Promise<number | undefined>;

  constructor(protected deps: WebSurfaceDeps) {
    this.cards = new CardDesk(this.bus, deps.clock);
  }

  onMessage(handler: (m: InboundMessage) => Promise<number | undefined>): void {
    this.handler = handler;
  }

  /** Hand out an upload slot for a file of the owner (presigned PUT, checked at send). */
  createUpload(i: { conversationId: string; name: string; type: string; size: number }) {
    return createUpload(this.deps, i);
  }

  /** Check the owner's message and uploads, save the files for the bot, hand it to the hub. */
  send(i: { conversationId: string; text: string; uploadIds?: string[]; replyTo?: number }) {
    return sendOwnerMessage(this.deps, this.handler, i);
  }

  /** Publish the message, then the unread count when a bot or the system wrote it. */
  async post(c: ConversationId, m: OutboundMessage): Promise<void> {
    let replied: OutboundMessage | undefined;
    if (m.replyTo !== undefined) {
      const r = await this.deps.store.messages.get(m.replyTo);
      if (r && r.conversationId === c) replied = r;
    }
    this.bus.publish({ type: "message", conversationId: c, message: toMessageDto(m, replied) });
    if (m.author.kind !== "user") await this.publishUnread(c);
  }

  /** Unread messages plus open cards of the conversation. */
  private async publishUnread(c: ConversationId): Promise<void> {
    const unread = (await this.deps.store.reads.unread(c)) + this.cards.openIn(c);
    this.bus.publish({ type: "unread", conversationId: c, unread });
  }

  /** Publish unread without ever failing the caller (a card must always get its answer). */
  private async publishUnreadSafe(c: ConversationId): Promise<void> {
    try {
      await this.publishUnread(c);
    } catch (e) {
      this.deps.log?.warn({ conversationId: c, err: String(e) }, "unread event failed");
    }
  }

  async askApproval(c: ConversationId, card: ApprovalCard): Promise<ApprovalAnswer> {
    const answer = this.cards.askApproval(c, card);
    await this.publishUnreadSafe(c);
    return answer;
  }

  async askQuestion(c: ConversationId, card: QuestionCard): Promise<QuestionAnswer | null> {
    const answer = this.cards.askQuestion(c, card);
    await this.publishUnreadSafe(c);
    return answer;
  }

  showActivity(c: ConversationId, a: Activity): void {
    this.bus.publish({
      type: "activity",
      conversationId: c,
      botId: a.botId,
      kind: a.kind,
      ...(a.label !== undefined && { label: a.label }),
    });
  }

  showRun(c: ConversationId, botId: string, step: RunStep): void {
    this.bus.publish({ type: "run", conversationId: c, botId, step });
  }

  /** Close every open card (engine shutdown). */
  cancelAll(): void {
    this.cards.cancelAll();
  }

  postFile(
    c: ConversationId,
    author: Author,
    file: { path: string; name: string },
    caption?: string,
  ): Promise<void> {
    return postBotFile({ ...this.deps, surface: this }, c, author, file, caption);
  }
}
