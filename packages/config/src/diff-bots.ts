import type { Bot, BotId } from "@friday/core";

/**
 * A bot without the owner's SOUL and USER text (that text is told to open sessions in their next turn, so a change of
 * it alone must not restart anyone) and without its avatar (display only, the model never sees it).
 */
function own(bot: Bot): Omit<Bot, "ownerPreface" | "avatar"> {
  const { ownerPreface, avatar: _avatar, ...rest } = bot;
  const prefix = ownerPreface ? `${ownerPreface}\n\n` : "";
  return { ...rest, instructions: rest.instructions.slice(prefix.length) };
}

/**
 * Bots whose sessions must restart after a reload: removed, or present in both with a different value (the owner's
 * SOUL and USER text and the avatar do not count). A `computer` change does count: its session's prompt and tools
 * name the computer. Added bots are not listed (they have no session yet). Sorted.
 */
export function diffBots(prev: Map<BotId, Bot>, next: Map<BotId, Bot>): BotId[] {
  const changed: BotId[] = [];
  for (const [id, bot] of prev) {
    const now = next.get(id);
    if (!now || JSON.stringify(own(now)) !== JSON.stringify(own(bot))) changed.push(id);
  }
  return changed.sort();
}
