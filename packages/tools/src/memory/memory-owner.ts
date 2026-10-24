import {
  type BotId,
  type Conversation,
  GROUP_SESSION_KINDS,
  type Group,
  type GroupId,
  type MemoryOwner,
} from "@friday/core";
import type { MemoryBullet } from "./file-memory";

/** What a session's tools may know: the bot, the conversation it answers now, and groups by id. */
export interface ToolSessionContext {
  botId: BotId;
  /** The conversation of the turn in progress (undefined between turns). */
  conversation(): Promise<Conversation | undefined>;
  group(id: GroupId): Promise<Group | undefined>;
  /** The group of a group session (`<botId>@<groupId>`); unset in the direct session. */
  groupId?: GroupId;
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

/**
 * The owner's notes a memory tool may show or change: all of them, except the bot's own notes in a group session,
 * where only `GROUP_SESSION_KINDS` are visible (facts and decisions may come from the owner's direct chat).
 */
export function visibleNotes(
  memory: { listBullets(owner: MemoryOwner): MemoryBullet[] },
  owner: MemoryOwner,
  ctx: ToolSessionContext,
): MemoryBullet[] {
  const all = memory.listBullets(owner);
  if (owner.kind !== "bot" || !ctx.groupId) return all;
  return all.filter((b) => (GROUP_SESSION_KINDS as readonly string[]).includes(b.kind));
}
