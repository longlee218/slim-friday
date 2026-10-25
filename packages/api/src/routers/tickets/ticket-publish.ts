import type { FridayEvent } from "@friday/contracts";
import type { Store, Ticket } from "@friday/core";
import { type ApiLog, logApiEvent } from "../../api-log";
import { ticketDtoFor } from "./ticket-dto";

/**
 * The `onTicketChange` listener of the hub: turn the saved ticket into a DTO (with its fresh comment
 * count) and publish one `ticket` event. A failure is logged, never thrown.
 */
export function ticketChangePublisher(d: {
  store: Pick<Store, "tickets">;
  bus: { publish(e: FridayEvent): unknown };
  log: ApiLog;
}): (t: Ticket) => void {
  return (t) =>
    void ticketDtoFor(d.store, t)
      .then((ticket) => d.bus.publish({ type: "ticket", ticket }))
      .catch((err) =>
        logApiEvent(
          d.log,
          "ticket.publish_failed",
          { error: String(err), ticketId: t.id },
          "error",
        ),
      );
}
