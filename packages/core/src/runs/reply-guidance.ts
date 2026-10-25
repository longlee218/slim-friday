import type { WakeRow } from "../domain/wake";
import { wakeAction } from "../routing/bot-messages";
import type { RunKind } from "./run-kind";

/** Reply guidance of a ticket run (R§6 `TICKET_SILENT_REPLY_GUIDANCE`, Friday's ticket tool names). */
export const TICKET_REPLY_GUIDANCE =
  "Ticket work is reported on the board, not in chat. Put updates and results in TicketComment and keep the ticket status current with TicketUpdate. Use the existing ask or approval mechanism when owner input is needed. Leave the final reply empty.";

/**
 * The reply guidance of one run, put at the end of its turn (never in the system prompt, so the cached prefix
 * does not change with the trigger; spec §6.3). An owner run gets none (the progress rule in the system prompt is
 * its guidance), nor does an intro run (its text says what to do); a bot run gets what its intent expects
 * (`wakeAction`, named after `senderName`); a ticket run reports on the board.
 */
export function replyGuidance(row: WakeRow, kind: RunKind, senderName: string): string | undefined {
  if (kind === "ticket") return TICKET_REPLY_GUIDANCE;
  if (kind !== "bot" || row.sender.kind !== "bot") return undefined;
  return wakeAction({
    from: { id: row.sender.botId, name: senderName },
    intent: row.intent,
    ...(row.handoff && { handoff: true }),
  });
}
