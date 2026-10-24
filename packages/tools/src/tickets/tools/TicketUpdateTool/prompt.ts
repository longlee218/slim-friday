/** Description the model reads for `TicketUpdate`. */
export const TICKET_UPDATE_DESCRIPTION =
  "Change a ticket: title, description, priority, status (todo, doing, review, blocked, done, closed) or assignee (a bot id or exact name). " +
  "Set doing when you start, review when your part is ready for checking, blocked with blockedReason saying why, done when finished. " +
  "Assigning it to another bot wakes that bot. A status change wakes nobody.";
