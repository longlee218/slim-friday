import { type BotRuntimeSpec, MEMORY_LABEL, RULES_LABEL } from "@friday/core";

/**
 * The system prompt of a session: who the bot is and its instructions, then what the session read at open: the
 * owner's rules for the bot (before the memory, never cut by the memory cap), the bot's memory, and for a group
 * session the group context, the group's rules and the group memory. Re-read at every open, so a resumed
 * transcript never piles up copies of them and a compaction keeps them.
 */
export function systemPromptOf(spec: BotRuntimeSpec): string {
  const { bot } = spec;
  const rules = spec.rules ? `\n\n## Your rules\n${RULES_LABEL}\n\n${spec.rules}` : "";
  const memory = spec.memory ? `\n\n## Your memory\n${MEMORY_LABEL}\n\n${spec.memory}` : "";
  const context = spec.groupContext ? `\n\n## Group context\n${spec.groupContext}` : "";
  const groupRules = spec.groupRules
    ? `\n\n## Group rules\n${RULES_LABEL}\n\n${spec.groupRules}`
    : "";
  const groupMemory = spec.groupMemory
    ? `\n\n## Group memory\n${MEMORY_LABEL}\n\n${spec.groupMemory}`
    : "";
  return `You are ${bot.name}, ${bot.title}.\n\n${bot.instructions}${rules}${memory}${context}${groupRules}${groupMemory}`;
}
