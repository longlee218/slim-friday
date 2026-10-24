import type { Bot, BotAddress } from "@friday/core";
import { renderRoster } from "@friday/core";

/** A group the bot is in, with its members. */
export interface Roster {
  name: string;
  members: BotAddress[];
}

/**
 * The bot with the roster of each of its groups appended to its instructions (names, ids, titles, and the rule that
 * one bot owns each step). A bot in no group is returned as it is.
 */
export function withRoster(bot: Bot, rosters: Roster[]): Bot {
  if (rosters.length === 0) return bot;
  const text = rosters.map((r) => renderRoster(bot, r.name, r.members)).join("\n\n");
  return { ...bot, instructions: `${bot.instructions}\n\n${text}` };
}
