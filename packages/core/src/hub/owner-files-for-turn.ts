import type { Store } from "../ports/store";
import { NO_OWNER_NOTE } from "./rules-label";
import type { PoolEntry } from "./session-pool";

/**
 * The owner's SOUL and USER text a turn must carry: the current text when it differs from what the session last saw
 * ("(none)" when both files are now empty), so an open session follows an edit without a restart. It becomes the text
 * shown. Undefined when nothing changed or the bot is no longer in the config.
 */
export async function ownerFilesForTurn(
  entry: PoolEntry,
  bots: Store["bots"],
): Promise<string | undefined> {
  const bot = await bots.get(entry.bot.id);
  if (!bot) return undefined;
  const now = bot.ownerPreface ?? "";
  if (now === entry.ownerShown) return undefined;
  entry.ownerShown = now;
  return now || NO_OWNER_NOTE;
}
