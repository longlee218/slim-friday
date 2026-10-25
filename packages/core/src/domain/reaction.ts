/** The emoji an owner may react with (the web picker offers exactly these). */
export const REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** The reaction a message text is, or undefined: a reaction is an owner reply that holds exactly one of `REACTIONS`. */
export function reactionOf(text: string): Reaction | undefined {
  const t = text.trim();
  return REACTIONS.find((r) => r === t);
}
