import { type BotRuntimeSpec, MEMORY_LABEL } from "@friday/core";

/**
 * The system prompt of a session: who the bot is and its instructions, then what the session read at open: the
 * bot's memory, and for a group session the group context and the group memory. Re-read at every open, so a
 * resumed transcript never piles up copies of them.
 */
export function systemPromptOf(spec: BotRuntimeSpec): string {
  const { bot } = spec;
  const memory = spec.memory ? `\n\n## Your memory\n${MEMORY_LABEL}\n\n${spec.memory}` : "";
  const context = spec.groupContext ? `\n\n## Group context\n${spec.groupContext}` : "";
  const groupMemory = spec.groupMemory
    ? `\n\n## Group memory\n${MEMORY_LABEL}\n\n${spec.groupMemory}`
    : "";
  return `You are ${bot.name}, ${bot.title}.\n\n${bot.instructions}${memory}${context}${groupMemory}`;
}
