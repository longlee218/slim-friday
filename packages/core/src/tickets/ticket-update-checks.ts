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

/**
 * Check an update of ticket `cur` by `actor` before it is saved: a refusal, or the cleaned title and
 * trimmed blocked reason to save (each undefined when not given).
 */
export async function checkUpdate(
  store: Pick<Store, "bots" | "groups">,
  secretValues: (() => string[]) | undefined,
  cur: Ticket,
  actor: Author,
  i: TicketUpdateInput,
): Promise<TicketResult<{ title?: string; reason?: string }>> {
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
  const reason = i.blockedReason?.trim();
  const blocks = (i.status ?? cur.status) === "blocked";
  if (reason !== undefined && (!blocks || reason.length > BLOCKED_REASON_MAX)) return INVALID;
  // A ticket already blocked keeps its reason; moving into blocked needs one.
  if (blocks && cur.status !== "blocked" && !reason) return REASON_REQUIRED;
  return {
    ok: true,
    ...(title !== undefined && { title }),
    ...(reason !== undefined && { reason }),
  };
}
