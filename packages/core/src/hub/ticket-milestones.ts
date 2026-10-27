import { type Ticket, type TicketStatus, ticketRef } from "../tickets/ticket";
import type { HubContext } from "./hub-context";
import { errText } from "./hub-types";
import { postStored } from "./post-stored";

/**
 * Post one short system message to the ticket's origin group when it moves to doing, done or
 * blocked. A ticket without a group, or any other status, posts nothing. System messages wake no
 * bot. A failure is logged, never thrown, so it cannot fail the ticket write.
 */
export async function postTicketMilestone(
  ctx: HubContext,
  t: Ticket,
  _from: TicketStatus,
): Promise<void> {
  if (!t.groupId) return;
  try {
    const ref = ticketRef(t.number);
    let text: string;
    if (t.status === "blocked") text = `${ref} is blocked: ${t.blockedReason ?? "no reason given"}`;
    else if (t.status === "doing" || t.status === "done") {
      const bot = t.assigneeBotId ? await ctx.deps.store.bots.get(t.assigneeBotId) : undefined;
      const name = bot?.name ?? t.assigneeBotId ?? "Someone";
      text = `${name} ${t.status === "doing" ? "started" : "finished"} ${ref}: ${t.title}`;
    } else return;
    // Not `tell`: it swallows its own errors, and a failed post must be logged here.
    await postStored(ctx.deps, {
      conversationId: `group:${t.groupId}`,
      author: { kind: "system" },
      text,
      at: ctx.deps.clock.now(),
    });
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), ticketId: t.id }, "hub.ticket_milestone_failed");
  }
}
