import type { Bot, BotId } from "../domain/bot";
import type { Conversation } from "../domain/conversation";
import type { Group } from "../domain/group";
import { parseMentions } from "./parse-mentions";

/**
 * Which bots a message wakes.
 * - Direct conversation: its bot (unless that bot wrote the message).
 * - Group: each mentioned member; with no mention, the entry bot, but only for a message from the user.
 *   A bot reply that mentions nobody wakes nobody. A bot is never woken by its own message.
 * `sender` is the bot that wrote the message; leave it out for a user message.
 */
export function routeMessage(
  conv: Conversation,
  group: Group | undefined,
  members: Bot[],
  text: string,
  sender?: BotId,
): BotId[] {
  if (conv.kind === "direct") return conv.botId === sender ? [] : [conv.botId];
  if (!group) return [];
  const mentioned = parseMentions(text, members).filter((id) => id !== sender);
  if (mentioned.length > 0) return mentioned;
  return sender === undefined ? [group.entryBot] : [];
}
