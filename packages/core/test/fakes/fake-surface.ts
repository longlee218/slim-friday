import type {
  Activity,
  ApprovalAnswer,
  ApprovalCard,
  Author,
  ConversationId,
  InboundMessage,
  OutboundMessage,
  Surface,
} from "../../src";

/** A Surface that records what the engine does and lets the test play the user. */
export class FakeSurface implements Surface {
  posts: { conversationId: ConversationId; message: OutboundMessage }[] = [];
  activities: { conversationId: ConversationId; activity: Activity }[] = [];
  approvals: { conversationId: ConversationId; card: ApprovalCard }[] = [];
  private handler: (m: InboundMessage) => void = () => {};
  private answer: ApprovalAnswer | "never" = "deny";

  onMessage(handler: (m: InboundMessage) => void): void {
    this.handler = handler;
  }
  async post(conversationId: ConversationId, message: OutboundMessage): Promise<void> {
    this.posts.push({ conversationId, message });
  }
  askApproval(conversationId: ConversationId, card: ApprovalCard): Promise<ApprovalAnswer> {
    this.approvals.push({ conversationId, card });
    return this.answer === "never" ? new Promise(() => {}) : Promise.resolve(this.answer);
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
  showActivity(conversationId: ConversationId, activity: Activity): void {
    this.activities.push({ conversationId, activity });
  }

  /** The user's answer to the next approval cards; "never" leaves them unanswered. */
  answerWith(a: ApprovalAnswer | "never"): void {
    this.answer = a;
  }
  /** The user sends a message. */
  deliver(m: InboundMessage): void {
    this.handler(m);
  }
}
