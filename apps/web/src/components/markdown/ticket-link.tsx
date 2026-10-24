import type { MouseEvent } from "react";
import { useIsPhone } from "../../app/use-is-phone";
import { useAppNavigate } from "../shell/use-app-navigate";
import { TicketHoverCard } from "../tickets/ticket-hover-card";

/**
 * Mono tint link to a ticket; navigates in-app (plain click) and keeps the normal link
 * behaviour for modified clicks. On desktop with a hover device it opens a preview card. The prop is `ticketRef`: `ref` is reserved in React 19.
 */
export function TicketLink({ ticketRef }: { ticketRef: string }) {
  const navigate = useAppNavigate();
  const phone = useIsPhone();
  const href = `/tickets/${ticketRef}`;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(href);
  };
  const link = (
    <a className="tk" href={href} onClick={onClick}>
      {ticketRef}
    </a>
  );
  // No hover on the phone or on touch screens: the plain link only.
  if (phone || window.matchMedia("(hover: none)").matches) return link;
  return <TicketHoverCard ticketRef={ticketRef}>{link}</TicketHoverCard>;
}
