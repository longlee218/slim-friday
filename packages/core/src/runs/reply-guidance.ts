import type { WakeRow } from "../domain/wake";
import { wakeAction } from "../routing/bot-messages";
import type { RunKind } from "./run-kind";

/** Reply guidance of a ticket run (R§6 `TICKET_SILENT_REPLY_GUIDANCE`, Friday's ticket tool names). */
export const TICKET_REPLY_GUIDANCE =
  "Ticket work is reported on the board, not in chat. Put updates and results in TicketComment and keep the ticket status current with TicketUpdate. Use the existing ask or approval mechanism when owner input is needed. Leave the final reply empty.";

/** Reply guidance of a schedule run in "only problems" mode (it may end with `NO_RESPONSE`). */
export const SCHEDULE_QUIET_GUIDANCE =
  "This is a scheduled run; the owner is not waiting in the chat. Reply only if there is a problem or something the owner must act on; otherwise the whole final reply is exactly NO_RESPONSE. You cannot post progress updates in this run.";

/** Reply guidance of a schedule run that posts its result every time. */
export const SCHEDULE_REPLY_GUIDANCE =
  "This is a scheduled run; the owner is not waiting in the chat. Write the result as your final answer; it is posted to the chat. You cannot post progress updates in this run.";

/**
 * One line for runs without `PostUpdate` (the system prompt names it for every kind, kept identical for cache
 * stability, so the turn says it is absent here).
 */
export const NO_PROGRESS_UPDATES_NOTE =
  "You cannot post progress updates in this run; write your final answer only.";

/**
 * The reply guidance of one run, put at the end of its turn (never in the system prompt, so the cached prefix
 * does not change with the trigger; spec §6.3). An owner run gets none (the progress rule in the system prompt is
 * its guidance), nor does an intro run (its text says what to do); a bot run gets what its intent expects
 * (`wakeAction`, named after `senderName`); a ticket run reports on the board; a schedule run gets the quiet or the normal schedule line.
 */
export function replyGuidance(row: WakeRow, kind: RunKind, senderName: string): string | undefined {
  // A ticket run ends with an empty reply, so it only learns that progress updates are absent.
  if (kind === "ticket")
    return `${TICKET_REPLY_GUIDANCE} You cannot post progress updates in this run.`;
  if (kind === "schedule")
    return row.scheduleQuiet === true ? SCHEDULE_QUIET_GUIDANCE : SCHEDULE_REPLY_GUIDANCE;
  if (kind !== "bot" || row.sender.kind !== "bot") return undefined;
  const action = wakeAction({
    from: { id: row.sender.botId, name: senderName },
    intent: row.intent,
    ...(row.handoff && { handoff: true }),
  });
  return `${action} ${NO_PROGRESS_UPDATES_NOTE}`;
}
