import type { Bot, BotId } from "../domain/bot";
import type { Conversation } from "../domain/conversation";
import type { Store } from "../ports/store";
import { routeMessage } from "../routing/route-message";

/** Bots a user message in `conv` wakes; `replyToBot` is the bot whose message the user replies to. */
export async function hubTargets(
  store: Store,
  conv: Conversation,
  text: string,
  replyToBot?: BotId,
): Promise<BotId[]> {
  if (conv.kind === "direct") {
    const bot = await store.bots.get(conv.botId);
    return bot ? routeMessage(conv, undefined, [bot], text) : [];
  }
  const group = await store.groups.get(conv.groupId);
  if (!group) return [];
  const members = (await Promise.all(group.members.map((id) => store.bots.get(id)))).filter(
    (b): b is Bot => b !== undefined,
  );
  return routeMessage(conv, group, members, text, undefined, replyToBot);
}
