import { type Ticket, ticketRef } from "../tickets/ticket";
import { finished } from "../tickets/ticket-board-rules";
import { blockersOf } from "../tickets/ticket-dependencies";
import type { HubContext } from "./hub-context";
import { errText } from "./hub-types";
import { postReadyToStart } from "./ticket-milestones";
import { ticketWakeText } from "./ticket-support";
import { wakeForTicket } from "./ticket-wakes";

const SYSTEM = { kind: "system" } as const;

/** The wake text of a released ticket: the default one, plus a note per blocker that was closed. */
const releasedWakeText = (dep: Ticket, blockers: Ticket[]): string =>
  ticketWakeText(dep) +
  blockers
    .filter((b) => b.status === "closed")
    .map((b) => `\n${ticketRef(b.number)}, which this waited on, was closed without being done.`)
    .join("");

/**
 * After `done` moved to `done` or `closed`: wake the assignee of each ticket that waited on it, is
 * `todo` and now waits on nothing, and post its ready line to its group. Each dependent is woken once
 * per set of blockers (the dedupe key), so finishing a blocker again wakes nobody. Never throws.
 */
export async function releaseDependents(ctx: HubContext, done: Ticket): Promise<void> {
  if (!finished(done.status)) return;
  try {
    // One failing dependent must not keep the others waiting.
    for (const dep of await ctx.deps.store.tickets.blockedByTicket(done.id))
      await release(ctx, dep).catch((err) =>
        ctx.deps.log?.error({ error: errText(err), ticketId: dep.id }, "hub.ticket_release_failed"),
      );
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), ticketId: done.id }, "hub.ticket_release_failed");
  }
}

/** Wake and announce `dep` when it is `todo`, has an assignee and waits on nothing any more. */
async function release(ctx: HubContext, dep: Ticket): Promise<void> {
  if (dep.status !== "todo" || !dep.assigneeBotId) return;
  const blockers = await blockersOf(ctx.deps.store, dep);
  if (blockers.some((b) => !finished(b.status))) return;
  const ids = [...(dep.blockedBy ?? [])].sort().join(",");
  const woke = await wakeForTicket(ctx, dep, dep.assigneeBotId, false, SYSTEM, {
    text: releasedWakeText(dep, blockers),
    dedupeKey: `unblocked:${dep.id}:${ids}`,
  });
  // Only a new run announces the ticket: a replayed key was announced the first time.
  if (woke?.ok && !woke.replayed) await postReadyToStart(ctx, dep, blockers);
}
