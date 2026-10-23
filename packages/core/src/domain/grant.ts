import type { BotId } from "./bot";

/** A stored "always allow": a bot (or any bot) may call a tool within a scope. */
export interface Grant {
  id: string;
  botId: BotId | "*";
  tool: string;
  /** Scope key to value; "*" as a value matches anything. */
  scope: Record<string, string>;
  createdAt: number;
  /** Epoch milliseconds; absent = never expires. */
  expiresAt?: number;
}
