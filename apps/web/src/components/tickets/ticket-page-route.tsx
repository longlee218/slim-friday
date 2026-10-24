import { useParams } from "react-router";
import { useIsPhone } from "../../app/use-is-phone";
import { PhoneTicketView } from "./phone-ticket-view";
import { TicketPage } from "./ticket-page";

/** `/tickets/:ref`: the full page on desktop; the pushed ticket view on the phone. */
export function TicketPageRoute() {
  const { ref = "" } = useParams();
  return useIsPhone() ? <PhoneTicketView ticketRef={ref} /> : <TicketPage ticketRef={ref} />;
}
