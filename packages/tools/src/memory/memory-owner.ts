import type { BotId, Conversation, Group, GroupId, MemoryOwner } from "@friday/core";

/** What a session's tools may know: the bot, the conversation it answers now, and groups by id. */
export interface ToolSessionContext {
  botId: BotId;
  /** The conversation of the turn in progress (undefined between turns). */
  conversation(): Promise<Conversation | undefined>;
  group(id: GroupId): Promise<Group | undefined>;
  /** The bot's own direct conversation (`MessageSearch` looks there too); absent = only the current one. */
  direct?(): Promise<Conversation | undefined>;
}

/** Where a memory tool reads or writes. */
export type MemoryScope = "bot" | "group";

/** Refusal text for a group scope used outside a group the bot belongs to. */
export const GROUP_SCOPE_REFUSED =
  "group memory is only reachable from a group conversation you are a member of";

/**
 * The memory owner of a tool call: the bot itself, or the group of the conversation it answers now when that is a
 * group it is a member of. Anything else returns the refusal text.
 */
export async function resolveOwner(
  scope: MemoryScope,
  ctx: ToolSessionContext,
): Promise<MemoryOwner | string> {
  if (scope === "bot") return { kind: "bot", botId: ctx.botId };
  const conv = await ctx.conversation();
  if (conv?.kind !== "group") return GROUP_SCOPE_REFUSED;
  const group = await ctx.group(conv.groupId);
  if (!group?.members.includes(ctx.botId)) return GROUP_SCOPE_REFUSED;
  return { kind: "group", groupId: group.id };
}
