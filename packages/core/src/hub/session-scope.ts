import type { Bot } from "../domain/bot";
import type { Conversation } from "../domain/conversation";
import type { Group, GroupId } from "../domain/group";
import { scopeKeyOf } from "../runs/run-rules";

/** Which session of a bot a conversation belongs to: its direct one, or its one for a group. */
export interface SessionScope {
  /** Session key (`scopeKeyOf`): `<botId>` (direct), `<botId>@<groupId>` (group) or `<botId>#ticket@<groupId>`. */
  key: string;
  /** The group of a group or ticket scope; none for the direct scope. */
  groupId?: GroupId;
  /** The bot as this session runs it (a group scope works in the group's workspaces). */
  bot: Bot;
}

/** Shapes a bot for one scope (the app adds per-scope dirs and text); `groupId` is unset for the direct scope. */
export type ScopeBot = (bot: Bot, groupId?: GroupId) => Bot;

/**
 * The scope of `bot` in `conv`. A group conversation needs its `group`, and the bot must be a member;
 * otherwise there is no scope (the wake is dropped). A direct conversation with `ticketGroup` (a wake of a
 * ticket of that group) gets the bot's ticket scope of the group, again only for a member. `scopeBot` shapes
 * the bot first, then a group or ticket scope replaces its workspaces with the group's.
 */
export function sessionScope(
  bot: Bot,
  conv: Conversation,
  group: Group | undefined,
  scopeBot?: ScopeBot,
  ticketGroup?: Group,
): SessionScope | undefined {
  if (conv.kind === "direct" && !ticketGroup)
    return { key: bot.id, bot: scopeBot ? scopeBot(bot) : bot };
  const g = conv.kind === "direct" ? ticketGroup : group;
  if (!g || (conv.kind === "group" && g.id !== conv.groupId) || !g.members.includes(bot.id))
    return undefined;
  const shaped = scopeBot ? scopeBot(bot, g.id) : bot;
  return {
    key: scopeKeyOf(bot.id, g.id, conv.kind === "direct" ? "ticket" : undefined),
    groupId: g.id,
    bot: { ...shaped, workspaces: g.workspaces },
  };
}
