import type { Bot, BotId } from "../domain/bot";
import type { Conversation } from "../domain/conversation";
import type { Store } from "../ports/store";
import { parseMentions } from "../routing/parse-mentions";
import { routeMessage } from "../routing/route-message";

/** The bots a user message wakes, and which of them it @mentions (always none in a direct conversation). */
export interface HubTargets {
  bots: BotId[];
  mentioned: BotId[];
}

/** Bots a user message in `conv` wakes; `replyToBot` is the bot whose message the user replies to. */
export async function hubTargets(
  store: Store,
  conv: Conversation,
  text: string,
  replyToBot?: BotId,
): Promise<HubTargets> {
  if (conv.kind === "direct") {
    const bot = await store.bots.get(conv.botId);
    return { bots: bot ? routeMessage(conv, undefined, [bot], text) : [], mentioned: [] };
  }
  const group = await store.groups.get(conv.groupId);
  if (!group) return { bots: [], mentioned: [] };
  const members = (await Promise.all(group.members.map((id) => store.bots.get(id)))).filter(
    (b): b is Bot => b !== undefined,
  );
  return {
    bots: routeMessage(conv, group, members, text, undefined, replyToBot),
    mentioned: parseMentions(text, members),
  };
}
