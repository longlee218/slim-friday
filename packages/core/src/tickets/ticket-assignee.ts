import type { BotId } from "../domain/bot";
import type { GroupId } from "../domain/group";
import type { Store } from "../ports/store";
import { NOT_MEMBER_CODE, type TicketErrorCode, UNKNOWN_BOT } from "./ticket-board-rules";

/**
 * Why `botId` (none: nobody is assigned) may not be assigned a ticket of `groupId` (none: ungrouped), or undefined when it
 * may: the bot must exist and, for a group ticket, be a member of that (still existing) group.
 */
export async function assigneeRefusal(
  store: Pick<Store, "bots" | "groups">,
  botId: BotId | undefined,
  groupId?: GroupId,
): Promise<typeof UNKNOWN_BOT | { ok: false; code: TicketErrorCode; error: string } | undefined> {
  if (botId === undefined) return undefined;
  if (!(await store.bots.get(botId))) return UNKNOWN_BOT;
  if (groupId === undefined) return undefined;
  const group = await store.groups.get(groupId);
  if (group?.members.includes(botId)) return undefined;
  return {
    ok: false,
    code: NOT_MEMBER_CODE,
    error: `${botId} is not a member of group ${group?.name ?? groupId}`,
  };
}
