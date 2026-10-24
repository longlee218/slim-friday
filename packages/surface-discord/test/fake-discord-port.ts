import type {
  ChannelInfo,
  DiscordPort,
  IncomingClick,
  IncomingCommand,
  IncomingMessage,
} from "../src/discord-port";

type Method =
  | "send"
  | "sendAs"
  | "typing"
  | "sendButtons"
  | "editMessage"
  | "createCategory"
  | "createPrivateChannel";

/** A DiscordPort that records every call and lets a test play Discord. */
export class FakeDiscordPort implements DiscordPort {
  ownerId = "owner";
  sent: { channelId: string; text: string }[] = [];
  sentAs: { channelId: string; username: string; text: string }[] = [];
  typings: string[] = [];
  buttons: {
    channelId: string;
    messageId: string;
    text: string;
    buttons: { id: string; label: string; style: string }[];
  }[] = [];
  edits: { channelId: string; messageId: string; text: string }[] = [];
  channels: ChannelInfo[] = [];
  categoriesCreated = 0;
  private nextId = 1;
  private failing = new Set<Method>();
  private messageHandler: (m: IncomingMessage) => void = () => {};
  private clickHandler: (c: IncomingClick) => void = () => {};
  private commandHandler: (c: IncomingCommand) => void = () => {};

  /** Make the next call of `method` reject once. */
  failNext(method: Method): void {
    this.failing.add(method);
  }
  private check(method: Method): void {
    if (this.failing.delete(method)) throw new Error(`${method} failed`);
  }

  onMessage(h: (m: IncomingMessage) => void): void {
    this.messageHandler = h;
  }
  onClick(h: (c: IncomingClick) => void): void {
    this.clickHandler = h;
  }
  onCommand(h: (c: IncomingCommand) => void): void {
    this.commandHandler = h;
  }

  /** The owner (or someone else) writes in a channel. */
  emitMessage(m: Partial<IncomingMessage> & { channelId: string; text: string }): void {
    this.messageHandler({ authorId: this.ownerId, fromBotOrWebhook: false, ...m });
  }
  /** A click on a button; resolves when the handler acked it. */
  emitClick(channelId: string, customId: string, userId = this.ownerId): Promise<void> {
    return new Promise((resolve) => {
      this.clickHandler({ channelId, userId, customId, ack: async () => resolve() });
      // a click the handler never acks must not hang the test
      setTimeout(resolve, 20);
    });
  }
  /** A slash command; returns the replies the handler sent. */
  async emitCommand(
    c: { channelId: string; name: "stop" | "status"; botName?: string },
    userId = this.ownerId,
  ): Promise<string[]> {
    const replies: string[] = [];
    this.commandHandler({ ...c, userId, reply: async (t) => void replies.push(t) });
    await Bun.sleep(20);
    return replies;
  }

  async send(channelId: string, text: string): Promise<void> {
    this.check("send");
    this.sent.push({ channelId, text });
  }
  async sendAs(channelId: string, username: string, text: string): Promise<void> {
    this.check("sendAs");
    this.sentAs.push({ channelId, username, text });
  }
  async typing(channelId: string): Promise<void> {
    this.check("typing");
    this.typings.push(channelId);
  }
  async sendButtons(
    channelId: string,
    text: string,
    buttons: { id: string; label: string; style: "primary" | "secondary" | "danger" }[],
  ): Promise<string> {
    this.check("sendButtons");
    const messageId = `m${this.nextId++}`;
    this.buttons.push({ channelId, messageId, text, buttons });
    return messageId;
  }
  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    this.check("editMessage");
    this.edits.push({ channelId, messageId, text });
  }
  async listChannels(): Promise<ChannelInfo[]> {
    return [...this.channels];
  }
  async createCategory(name: string): Promise<string> {
    this.check("createCategory");
    const id = `c${this.nextId++}`;
    this.categoriesCreated++;
    this.channels.push({ id, name });
    return id;
  }
  async createPrivateChannel(name: string, parentId: string, topic: string): Promise<string> {
    this.check("createPrivateChannel");
    const id = `c${this.nextId++}`;
    this.channels.push({ id, name, topic, parentId });
    return id;
  }
}
