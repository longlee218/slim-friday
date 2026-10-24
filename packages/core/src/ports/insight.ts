import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";

/**
 * Use of one thing by a bot, from its stored run steps. `name` is the skill name (kind `skill`), the MCP server
 * (`mcp`), `Bash` (`command`), `Agent` (`subagent`), else the step label.
 */
export interface RunStat {
  kind: string;
  name: string;
  uses: number;
  failed: number;
  /** Epoch milliseconds of the newest use. */
  lastAt: number;
}

/** One bot turn that has run steps: the bot message that closed it. */
export interface TurnSummary {
  messageId: number;
  conversationId: ConversationId;
  at: number;
  steps: number;
  failed: number;
  /** From the first step's start to the last step's end; 0 when unknown. */
  durationMs: number;
}

/** What a bot did since a time: turns, failures, cost, stuck work. */
export interface BotActivity {
  botId: BotId;
  turns: number;
  failedSteps: number;
  /** Newest bot message, or 0. */
  lastAt: number;
  costUsd: number;
  /** Wakes to this bot that ended blocked, interrupted, expired or dropped. */
  badWakes: number;
  /** Tickets assigned to this bot that are `blocked` now. */
  blockedTickets: number;
}

/**
 * Read-only views over the engine's own log (messages with run steps, wakes, spend, tickets) for reviewing bots.
 * Never reads an agent library's files: the run steps come from the generic runtime events.
 */
export interface InsightStore {
  /** Per step kind and name, newest use first. */
  runStats(botId: BotId, since: number): Promise<RunStat[]>;
  /** Turns with run steps, newest first, at most `limit`. */
  turns(botId: BotId, since: number, limit: number): Promise<TurnSummary[]>;
  /** One row per bot that did anything since `since`. */
  activity(since: number): Promise<BotActivity[]>;
}
