import type { GroupId } from "../domain/group";
import type { Ticket } from "../tickets/ticket";
import type { HubContext } from "./hub-context";
import { errText } from "./hub-types";

/**
 * Why an open group ticket can no longer run, or undefined when it can: its group is gone from config, or its
 * assignee is not a member of it. Tickets without a group or an assignee are never orphans.
 */
async function orphanReason(ctx: HubContext, t: Ticket): Promise<string | undefined> {
  if (t.groupId === undefined || t.assigneeBotId === undefined) return undefined;
  const group = await ctx.deps.store.groups.get(t.groupId);
  if (!group) return `group ${t.groupId} was removed`;
  if (!group.members.includes(t.assigneeBotId))
    return `assignee is no longer in group ${group.name}`;
  return undefined;
}

/**
 * Block `t` when it is an orphan (see `orphanReason`), through the board so the group gets its milestone.
 * Resolves true when the ticket was an orphan, whether or not the block itself was accepted.
 */
export async function blockIfOrphan(ctx: HubContext, t: Ticket): Promise<boolean> {
  const reason = await orphanReason(ctx, t);
  if (reason === undefined) return false;
  const r = await ctx.tickets.update(
    { kind: "system" },
    { id: t.id, status: "blocked", blockedReason: reason },
  );
  if (!r.ok)
    ctx.deps.log?.error({ ticketId: t.id, code: r.code }, "hub.ticket_orphan_block_refused");
  return true;
}

/**
 * After a config reload: block the open (todo/doing) tickets of the given groups whose group is gone or whose
 * assignee left it. Members' tickets and other groups' tickets are untouched.
 */
export async function blockOrphanTickets(ctx: HubContext, groupIds: GroupId[]): Promise<void> {
  for (const id of groupIds) {
    // One failing group or ticket must not stop the others, nor fail the reload.
    try {
      for (const t of await ctx.deps.store.tickets.openOfGroup(id)) {
        try {
          await blockIfOrphan(ctx, t);
        } catch (err) {
          ctx.deps.log?.error(
            { error: errText(err), ticketId: t.id },
            "hub.ticket_orphan_check_failed",
          );
        }
      }
    } catch (err) {
      ctx.deps.log?.error({ error: errText(err), groupId: id }, "hub.ticket_orphan_check_failed");
    }
  }
}
