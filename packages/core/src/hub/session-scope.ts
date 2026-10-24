import type { Bot } from "../domain/bot";
import type { Conversation } from "../domain/conversation";
import type { Group, GroupId } from "../domain/group";

/** Which session of a bot a conversation belongs to: its direct one, or its one for a group. */
export interface SessionScope {
  /** Session key: the bot id (direct) or `<botId>@<groupId>` (group). */
  key: string;
  /** The group of a group scope; none for the direct scope. */
  groupId?: GroupId;
  /** The bot as this session runs it (a group scope works in the group's workspaces). */
  bot: Bot;
}

/** Shapes a bot for one scope (the app adds per-scope dirs and text); `groupId` is unset for the direct scope. */
export type ScopeBot = (bot: Bot, groupId?: GroupId) => Bot;

/**
 * The scope of `bot` in `conv`. A group conversation needs its `group`, and the bot must be a member;
 * otherwise there is no scope (the wake is dropped). `scopeBot` shapes the bot first, then a group
 * scope replaces its workspaces with the group's.
 */
export function sessionScope(
  bot: Bot,
  conv: Conversation,
  group: Group | undefined,
  scopeBot?: ScopeBot,
): SessionScope | undefined {
  if (conv.kind === "direct") return { key: bot.id, bot: scopeBot ? scopeBot(bot) : bot };
  if (!group || group.id !== conv.groupId || !group.members.includes(bot.id)) return undefined;
  const shaped = scopeBot ? scopeBot(bot, group.id) : bot;
  return {
    key: `${bot.id}@${group.id}`,
    groupId: group.id,
    bot: { ...shaped, workspaces: group.workspaces },
  };
}
