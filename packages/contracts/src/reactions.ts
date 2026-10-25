/** The emoji an owner may react to a bot message with (the engine's `REACTIONS` lists the same ones). */
export const MESSAGE_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;
export type MessageReaction = (typeof MESSAGE_REACTIONS)[number];
