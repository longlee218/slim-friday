import { useIsPhone } from "../../app/use-is-phone";
import { PhonePlaceholder } from "../phone/phone-placeholder";
import { TicketsPage } from "./tickets-page";

/** `/tickets`: the board on desktop; the phone tab body is built in Task 10 (placeholder until then). */
export function TicketsRoute() {
  return useIsPhone() ? <PhonePlaceholder title="Tickets" /> : <TicketsPage />;
}
