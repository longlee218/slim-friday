import { useIsPhone } from "../../app/use-is-phone";
import { PhoneTicketsTab } from "./phone-tickets-tab";
import { TicketsPage } from "./tickets-page";

/** `/tickets`: the board on desktop, the phone Tickets tab below 640 px. */
export function TicketsRoute() {
  return useIsPhone() ? <PhoneTicketsTab /> : <TicketsPage />;
}
