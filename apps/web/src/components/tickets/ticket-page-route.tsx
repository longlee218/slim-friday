import { useParams } from "react-router";
import { useIsPhone } from "../../app/use-is-phone";
import { PhoneTicketView } from "./phone-ticket-view";
import { TicketPage } from "./ticket-page";

/**
 * `/tickets/:ref`: the full page on desktop; the pushed ticket view on the phone. The ref is
 * upper-cased (`fri-3` → `FRI-3`) so the cache key matches what live patches and edits use.
 */
export function TicketPageRoute() {
  const ref = (useParams().ref ?? "").toUpperCase();
  return useIsPhone() ? <PhoneTicketView ticketRef={ref} /> : <TicketPage ticketRef={ref} />;
}
