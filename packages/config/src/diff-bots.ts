import type { Bot, BotId } from "@friday/core";

/**
 * Bots whose sessions must restart after a reload: removed, or present in both with a different value.
 * Added bots are not listed (they have no session yet). Sorted.
 */
export function diffBots(prev: Map<BotId, Bot>, next: Map<BotId, Bot>): BotId[] {
  const changed: BotId[] = [];
  for (const [id, bot] of prev) {
    const now = next.get(id);
    if (!now || JSON.stringify(now) !== JSON.stringify(bot)) changed.push(id);
  }
  return changed.sort();
}
