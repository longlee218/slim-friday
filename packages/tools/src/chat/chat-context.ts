import type {
  BotId,
  BotMessenger,
  ConversationId,
  EffortLevel,
  PostUpdateResult,
  RunKind,
} from "@friday/core";

/** What the chat tools of one session need from the app. */
export interface ChatContext {
  botId: BotId;
  /** The bot's workspaces (absolute). */
  workspaces: string[];
  /** The bot's own scratch dir (absolute); it lies inside the agent home. */
  scratchDir: string;
  /** The agent home (absolute): nothing in it is sent except the bot's own scratch dir. */
  agentHome: string;
  /** The effort the `SetEffort` tool may use: the ceiling (none = cannot change) and the call that applies a level. */
  effort: { max?: EffortLevel; apply?: (level: EffortLevel) => Promise<void> };
  /** Reaches the other bots of the bot's group; none for a bot in no group (it gets no `SendToBot` / `HandOff`). */
  messenger?: BotMessenger;
  /** What started the run: `PostUpdate` is offered to an `owner` run only. */
  runKind: RunKind;
  /** Posts a progress update of the run (budget applied by the hub); unset outside a stored run. */
  postUpdate?: (text: string) => Promise<PostUpdateResult>;
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
