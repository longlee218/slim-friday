import type { Author } from "../domain/message";
import type { Store } from "../ports/store";
import type { Ticket } from "./ticket";
import { acceptanceRefusal } from "./ticket-acceptance";
import { assigneeRefusal } from "./ticket-assignee";
import {
  BAD_STATUS,
  BLOCKED_REASON_MAX,
  cleanText,
  DESCRIPTION_MAX,
  INVALID,
  PRIORITIES,
  REASON_REQUIRED,
  STATUSES,
  TITLE_MAX,
  type TicketResult,
  type TicketUpdateInput,
} from "./ticket-board-rules";
import { resolveBlockers, STARTED_CANNOT_WAIT, waitingOn } from "./ticket-dependencies";

/**
 * Check an update of ticket `cur` by `actor` before it is saved: a refusal, or the cleaned title,
 * trimmed blocked reason and resolved blocker ids to save (each undefined when not given).
 */
export async function checkUpdate(
  store: Pick<Store, "bots" | "groups" | "tickets">,
  secretValues: (() => string[]) | undefined,
  cur: Ticket,
  actor: Author,
  i: TicketUpdateInput,
): Promise<TicketResult<{ title?: string; reason?: string; blockedBy?: string[] }>> {
  if (i.status !== undefined && !STATUSES.includes(i.status)) return BAD_STATUS;
  const notAllowed = acceptanceRefusal(cur, actor, i.status);
  if (notAllowed) return notAllowed;
  const title = i.title === undefined ? undefined : cleanText(secretValues, i.title.trim());
  if (title !== undefined && (!title || title.length > TITLE_MAX)) return INVALID;
  if (i.description && i.description.length > DESCRIPTION_MAX) return INVALID;
  if (i.priority !== undefined && !PRIORITIES.includes(i.priority)) return INVALID;
  // The ticket's own group decides who may take it, not the acting session's.
  const refused = await assigneeRefusal(store, i.assigneeBotId, cur.groupId);
  if (refused) return refused;
  // Reopening a ticket keeps its assignee, who must still be allowed to take it: an orphan is re-assigned.
  const reopens = i.status === "todo" || i.status === "doing" || i.status === "review";
  if (reopens && i.assigneeBotId === undefined) {
    const stale = await assigneeRefusal(store, cur.assigneeBotId, cur.groupId);
    if (stale) return { ...stale, error: `${stale.error}: re-assign it` };
  }
  const reason = i.blockedReason?.trim();
  const blocks = (i.status ?? cur.status) === "blocked";
  if (reason !== undefined && (!blocks || reason.length > BLOCKED_REASON_MAX)) return INVALID;
  // A ticket already blocked keeps its reason; moving into blocked needs one.
  if (blocks && cur.status !== "blocked" && !reason) return REASON_REQUIRED;
  const deps = i.blockedBy && (await resolveBlockers(store, cur.id, i.blockedBy));
  if (deps && !deps.ok) return deps;
  // A started ticket cannot be put back to waiting; finished blockers are only a record.
  if (
    deps &&
    (i.status ?? cur.status) !== "todo" &&
    (await waitingOn(store, { ...cur, blockedBy: deps.ids })).length
  )
    return STARTED_CANNOT_WAIT;
  return {
    ok: true,
    ...(title !== undefined && { title }),
    ...(reason !== undefined && { reason }),
    ...(deps && { blockedBy: deps.ids }),
  };
}
