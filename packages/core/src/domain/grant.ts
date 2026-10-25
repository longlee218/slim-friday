import type { BotId } from "./bot";

/** What an owner rule does with the calls it matches (spec §6.14). */
export type RuleEffect = "always_allow" | "require_approval";

/** What an owner rule matches on; the more specific kind wins (site 4 > tool 3 > server 2 > category 1). */
export type RuleMatch = "site" | "tool" | "server" | "category";

/** The categories a `category` rule can name (`categoryOf`). */
export type RuleCategory = "email" | "purchase";

/**
 * An owner rule (spec §6.14; the "always allow" grants of older builds are `always_allow` + `tool` rules):
 * calls of a bot (or of every bot) that match it are always allowed or always asked.
 */
export interface Grant {
  id: string;
  botId: BotId | "*";
  /** Allow without a card, or always ask (even at `autonomous`, even for a read). */
  effect: RuleEffect;
  /** Which part of a call `tool` is compared with. */
  match: RuleMatch;
  /**
   * The matched value: the tool name (`tool`), the registrable domain of a `WebFetch` url (`site`), the MCP
   * server id (`server`) or a `RuleCategory` (`category`).
   */
  tool: string;
  /** For a `tool` rule: scope key to value; "*" as a value matches anything. Empty for the other kinds. */
  scope: Record<string, string>;
  createdAt: number;
  /** Epoch milliseconds; absent = never expires. */
  expiresAt?: number;
}
