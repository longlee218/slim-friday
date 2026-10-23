import type { Author, InboundTurn } from "@friday/core";

/** Display name of an author: the user, the system, or a bot by name (its id when the name is unknown). */
function nameOf(author: Author, names: Record<string, string>): string {
  if (author.kind === "bot") return names[author.botId] ?? author.botId;
  return author.kind;
}

/**
 * The text a bot reads for one inbound turn: a header naming the conversation, the sender and the hop,
 * then the message. A group turn with context starts with the recent messages; the last context
 * message is left out when it is the triggering message itself.
 */
export function formatTurn(turn: InboundTurn, names: Record<string, string>): string {
  const last = turn.context.at(-1);
  const recent = last && last.text === turn.text ? turn.context.slice(0, -1) : turn.context;
  const block = recent.length
    ? `Recent messages:\n${recent.map((m) => `${nameOf(m.author, names)}: ${m.text}`).join("\n")}\n\n`
    : "";
  return `${block}[conversation ${turn.conversationId}] ${nameOf(turn.from, names)} (hop ${turn.hop}):\n${turn.text}`;
}
