import type { BotId, ConversationId } from "@friday/core";

/** What the chat tools of one session need from the app. */
export interface ChatContext {
  botId: BotId;
  /** The bot's workspaces (absolute). */
  workspaces: string[];
  /** The bot's own scratch dir (absolute); it lies inside the agent home. */
  scratchDir: string;
  /** The agent home (absolute): nothing in it is sent except the bot's own scratch dir. */
  agentHome: string;
  /** True when the real path is a sensitive file (`.env`, keys...) of its workspace. */
  isSensitive(real: string): boolean;
  /** The conversation of the turn in progress; undefined between turns. */
  conversation(): ConversationId | undefined;
  /** Send a file to a conversation under the bot's name. */
  postFile(
    conversationId: ConversationId,
    botId: BotId,
    file: { path: string; name: string },
    caption?: string,
  ): Promise<void>;
}
