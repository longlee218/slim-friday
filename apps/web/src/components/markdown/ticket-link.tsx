import type { MouseEvent } from "react";
import { useAppNavigate } from "../shell/use-app-navigate";

/**
 * Mono tint link to a ticket; navigates in-app (plain click) and keeps the normal link
 * behaviour for modified clicks. The prop is `ticketRef`: `ref` is reserved in React 19.
 */
export function TicketLink({ ticketRef }: { ticketRef: string }) {
  const navigate = useAppNavigate();
  const href = `/tickets/${ticketRef}`;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(href);
  };
  return (
    <a className="tk" href={href} onClick={onClick}>
      {ticketRef}
    </a>
  );
}
