import type { BotId, StoredMessage } from "@friday/core";

/**
 * The lines of a group conversation that are this bot's turns: its own messages and each owner message whose next
 * bot-authored message is this bot's (the owner lines it answered). Other bots' and system lines are left out, so
 * each bot's idle flush of a shared group conversation reads only what it took part in. `messages` are in time order.
 */
export function ownTurns(messages: StoredMessage[], botId: BotId): StoredMessage[] {
  const kept: StoredMessage[] = [];
  // Owner lines since the last bot message; kept once this bot answers them.
  let asked: StoredMessage[] = [];
  for (const m of messages) {
    if (m.author.kind === "user") asked.push(m);
    else if (m.author.kind === "bot") {
      if (m.author.botId === botId) kept.push(...asked, m);
      asked = [];
    }
  }
  return kept;
}
