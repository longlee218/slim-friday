import { type BotRuntimeSpec, MEMORY_LABEL, RULES_LABEL } from "@friday/core";
import { capabilityNotes, howFridayWorks, PROGRESS_RULE, SAFETY_RULES } from "./prompt-blocks";

/**
 * The system prompt of a session, stable blocks first so the SDK's prompt cache keeps the prefix (spec §6.4):
 * identity and instructions, how Friday works, skills/subagents/MCP notes, the safety block, the progress rule,
 * then what the session read at open: the owner's rules for the bot (before the memory, never cut by the memory
 * cap), the bot's memory, the bot's computer facts, for a group session the group context, rules and memory, for a direct session the
 * teammate directory, and last the open scratchpad items. No trigger guidance and no time: those are in the turn,
 * so every run kind gets the same prompt. Built at every open and resume, but a resumed session may keep answering
 * from its earlier state (cause not proven: see Session state in docs/system-architecture.md), so core sends
 * the changed parts in the turn as `<state_changed>`.
 */
export function systemPromptOf(spec: BotRuntimeSpec, scratchDir: string): string {
  const { bot } = spec;
  const section = (heading: string, text?: string, label?: string) =>
    text ? `## ${heading}\n${label ? `${label}\n\n` : ""}${text}` : undefined;
  const blocks = [
    `You are ${bot.name}, ${bot.title}.\n\n${bot.instructions}`,
    howFridayWorks(bot, scratchDir, spec.toolSearch),
    capabilityNotes(bot),
    section("Safety", SAFETY_RULES.join("\n")),
    section("Progress updates", PROGRESS_RULE),
    section("Your rules", spec.rules, RULES_LABEL),
    section("Your memory", spec.memory, MEMORY_LABEL),
    // The bot's own computer, if it has one (its `<computer>` block carries its own tags).
    spec.computerContext || undefined,
    section("Group context", spec.groupContext),
    section("Group rules", spec.groupRules, RULES_LABEL),
    section("Group memory", spec.groupMemory, MEMORY_LABEL),
    // The directory is for direct sessions only; a group session's roster is in its group context.
    spec.groupId ? undefined : section("Teammates", spec.teammates),
    spec.scratchpad || undefined,
  ];
  return blocks.filter(Boolean).join("\n\n");
}
