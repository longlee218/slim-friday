import type { Outcome } from "../domain/autonomy";
import type { Bot, BotId } from "../domain/bot";
import type { Conversation, ConversationId } from "../domain/conversation";
import type { Grant } from "../domain/grant";
import type { Group, GroupId } from "../domain/group";
import type { StoredMessage } from "../domain/message";
import type { ApprovalAnswer } from "./surface";

/** One decision on one tool call, kept for review. */
export interface AuditEntry {
  at: number;
  botId: BotId;
  tool: string;
  outcome: Outcome;
  answer?: ApprovalAnswer;
  reason: string;
}

/** Everything the engine persists. */
export interface Store {
  bots: { get(id: BotId): Promise<Bot | undefined>; list(): Promise<Bot[]> };
  groups: { get(id: GroupId): Promise<Group | undefined> };
  conversations: { get(id: ConversationId): Promise<Conversation | undefined> };
  messages: {
    append(m: StoredMessage): Promise<void>;
    /** The last `limit` messages, oldest first. */
    recent(c: ConversationId, limit: number): Promise<StoredMessage[]>;
  };
  grants: {
    /** The bot's grants plus the grants for every bot ("*"). */
    list(botId: BotId): Promise<Grant[]>;
    add(g: Grant): Promise<void>;
    revoke(id: string): Promise<void>;
  };
  sessions: {
    get(botId: BotId): Promise<string | undefined>;
    set(botId: BotId, sessionId: string): Promise<void>;
    clear(botId: BotId): Promise<void>;
  };
  spend: {
    add(botId: BotId, day: string, usd: number): Promise<void>;
    total(botId: BotId, day: string): Promise<number>;
  };
  audit: { append(e: AuditEntry): Promise<void> };
}
