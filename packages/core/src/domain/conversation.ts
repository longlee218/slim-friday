import type { BotId } from "./bot";
import type { GroupId } from "./group";

export type ConversationId = string;

/** A message stream: a one-to-one chat with a bot, or a group chat. */
export type Conversation =
  | { id: ConversationId; kind: "direct"; botId: BotId }
  | { id: ConversationId; kind: "group"; groupId: GroupId };
