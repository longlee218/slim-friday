import type { BotId } from "../domain/bot";
import type { Author } from "../domain/message";
import type { Store } from "../ports/store";
import type { Ticket } from "./ticket";
import type { TicketUpdateInput } from "./ticket-board-rules";
import { isWaiting, readyToWork } from "./ticket-dependencies";

/** What the wakes after a ticket update need from the board. */
export interface UpdateWakeDeps {
  store: Pick<Store, "tickets">;
  /** Called when a ticket is assigned to a bot other than the one who did it. */
  wake: (ticket: Ticket, botId: BotId, actor: Author) => Promise<void>;
  /** Told when a new `blockedBy` ended the wait of an assigned `todo` ticket; errors stay here. */
  onWaitEnded?: (t: Ticket, actor: Author) => Promise<void>;
}

/**
 * The wakes after `cur` was saved as `t` by `actor`:
 * - a new assignee other than the actor is woken, unless the ticket is finished or still waits;
 * - otherwise, when the update's `blockedBy` ended the wait of an assigned `todo` ticket, `onWaitEnded`
 *   is told, unless the actor is the assignee (it knows).
 */
export async function wakeAfterUpdate(
  deps: UpdateWakeDeps,
  cur: Ticket,
  t: Ticket,
  actor: Author,
  i: TicketUpdateInput,
): Promise<void> {
  const isActor = (b: BotId | undefined) => actor.kind === "bot" && actor.botId === b;
  const to = i.assigneeBotId;
  if (to && to !== cur.assigneeBotId) {
    if (!isActor(to) && (await readyToWork(deps.store, t))) await deps.wake(t, to, actor);
    return;
  }
  if (i.blockedBy === undefined || t.status !== "todo" || !t.assigneeBotId) return;
  if (isActor(t.assigneeBotId)) return;
  // `cur` holds the old blockers; their statuses are read now, which this update did not change.
  if ((await isWaiting(deps.store, cur)) && !(await isWaiting(deps.store, t)))
    await deps.onWaitEnded?.(t, actor).catch(() => {});
}
