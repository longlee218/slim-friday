import { useParams } from "react-router";
import { useIsPhone } from "../../app/use-is-phone";
import { PhonePlaceholder } from "../phone/phone-placeholder";
import { TicketPage } from "./ticket-page";

/** `/tickets/:ref`: the full page on desktop; the phone push view is built in Task 10. */
export function TicketPageRoute() {
  const { ref = "" } = useParams();
  return useIsPhone() ? <PhonePlaceholder title={ref} /> : <TicketPage ticketRef={ref} />;
}
