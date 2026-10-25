import { MESSAGE_REACTIONS, type MessageDto, type MessageReaction } from "@friday/contracts";

/** How many times the owner reacted with each emoji to one message. */
export type ReactionCounts = Partial<Record<MessageReaction, number>>;

/** The reaction a message is, or undefined: an owner reply holding exactly one emoji of `MESSAGE_REACTIONS`. */
export function reactionOfMessage(m: MessageDto): MessageReaction | undefined {
  if (m.author.kind !== "user" || !m.replyTo) return undefined;
  const text = m.text.trim();
  return MESSAGE_REACTIONS.find((r) => r === text);
}
