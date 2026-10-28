import { type Ticket, type TicketComment, type TicketStatus, ticketRef } from "../tickets/ticket";
import type { HubContext } from "./hub-context";
import { errText } from "./hub-types";
import { postStored } from "./post-stored";

/** Longest comment excerpt posted to the group, in characters. */
const COMMENT_EXCERPT_MAX = 300;

/** A bot's display name, falling back to its id, then to `fallback`. */
async function botName(ctx: HubContext, botId: string | undefined, fallback: string) {
  const bot = botId ? await ctx.deps.store.bots.get(botId) : undefined;
  return bot?.name ?? botId ?? fallback;
}

/** Post one system message to the ticket's origin group. A failure is logged, never thrown. */
async function postToGroup(ctx: HubContext, t: Ticket, text: () => Promise<string | undefined>) {
  if (!t.groupId) return;
  try {
    const body = await text();
    if (!body) return;
    // Not `tell`: it swallows its own errors, and a failed post must be logged here.
    await postStored(ctx.deps, {
      conversationId: `group:${t.groupId}`,
      author: { kind: "system" },
      text: body,
      at: ctx.deps.clock.now(),
    });
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), ticketId: t.id }, "hub.ticket_milestone_failed");
  }
}

/**
 * Post one short system message to the ticket's origin group when it moves to doing, review, done
 * or blocked. A ticket without a group, or any other status, posts nothing. System messages wake
 * no bot. A failure is logged, never thrown, so it cannot fail the ticket write.
 */
export function postTicketMilestone(ctx: HubContext, t: Ticket, _from: TicketStatus) {
  return postToGroup(ctx, t, async () => {
    const ref = ticketRef(t.number);
    if (t.status === "blocked") return `${ref} is blocked: ${t.blockedReason ?? "no reason given"}`;
    if (t.status === "review") {
      const by =
        t.createdBy.kind === "bot" ? await botName(ctx, t.createdBy.botId, "") : "the owner";
      const name = await botName(ctx, t.assigneeBotId, "Someone");
      return `${name} finished ${ref}, waiting for review by ${by}: ${t.title}`;
    }
    if (t.status !== "doing" && t.status !== "done") return undefined;
    const name = await botName(ctx, t.assigneeBotId, "Someone");
    return `${name} ${t.status === "doing" ? "started" : "finished"} ${ref}: ${t.title}`;
  });
}

/** Post the blocked line again when an already blocked ticket got a new reason. */
export function postBlockedReason(ctx: HubContext, t: Ticket) {
  return postTicketMilestone(ctx, t, "blocked");
}

/** Post the assignee's comment on a blocked ticket, so the group sees why it is stuck. */
export function postBlockedComment(ctx: HubContext, t: Ticket, c: TicketComment) {
  return postToGroup(ctx, t, async () => {
    if (t.status !== "blocked" || c.author.kind !== "bot" || c.author.botId !== t.assigneeBotId)
      return undefined;
    const name = await botName(ctx, c.author.botId, "Someone");
    return `${name} on ${ticketRef(t.number)} (blocked): ${c.body.slice(0, COMMENT_EXCERPT_MAX)}`;
  });
}

/** Post that a ticket's blockers all finished and it is ready to start. */
export function postReadyToStart(ctx: HubContext, t: Ticket, blockers: Ticket[]) {
  return postToGroup(ctx, t, async () => {
    const refs = blockers.map((b) => ticketRef(b.number)).join(", ");
    return `${ticketRef(t.number)} is ready to start (${refs} finished)`;
  });
}
