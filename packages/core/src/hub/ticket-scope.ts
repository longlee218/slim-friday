import type { Bot } from "../domain/bot";
import type { Conversation } from "../domain/conversation";
import type { Group } from "../domain/group";
import type { WakeRow } from "../domain/wake";
import type { Store } from "../ports/store";
import { type ScopeBot, type SessionScope, sessionScope } from "./session-scope";

/** What finding a run's scope reads. */
type ScopeStore = Pick<Store, "tickets" | "groups">;

/**
 * The origin group of a run's ticket. `undefined`: no group (no ticket, a deleted ticket, or a direct ticket);
 * `null`: the ticket has a group that is gone from config.
 */
export async function ticketGroupOf(
  store: ScopeStore,
  row: Pick<WakeRow, "ticketId">,
): Promise<Group | null | undefined> {
  if (!row.ticketId) return undefined;
  const groupId = (await store.tickets.get(row.ticketId))?.groupId;
  if (groupId === undefined) return undefined;
  return (await store.groups.get(groupId)) ?? null;
}

/**
 * The scope a run of `bot` in `conv` runs in. A ticket wake (direct conversation) of a group ticket gets the
 * bot's ticket scope of that group; a gone group or a bot no longer a member gives none (the wake is dropped).
 * Anything else is scoped by its conversation, as `sessionScope` says.
 */
export async function runScope(
  store: ScopeStore,
  bot: Bot,
  conv: Conversation,
  row: Pick<WakeRow, "ticketId">,
  scopeBot?: ScopeBot,
): Promise<SessionScope | undefined> {
  if (conv.kind === "group")
    return sessionScope(bot, conv, await store.groups.get(conv.groupId), scopeBot);
  const ticketGroup = await ticketGroupOf(store, row);
  if (ticketGroup === null) return undefined;
  return sessionScope(bot, conv, undefined, scopeBot, ticketGroup);
}
