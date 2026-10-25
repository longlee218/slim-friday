import { PreviewCard } from "@base-ui/react/preview-card";
import { useQuery } from "@tanstack/react-query";
import { type ReactElement, useState } from "react";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { Avatar } from "../ui/avatar";
import { StatusPill } from "./ticket-status";
import { UnassignedFace } from "./unassigned-face";

/** Popup body: title, status and assignee; fetched only while the card is open. */
function Body({ ticketRef, open }: { ticketRef: string; open: boolean }) {
  const dir = useDirectory();
  const q = useQuery({
    ...orpc.tickets.get.queryOptions({ input: { ref: ticketRef } }),
    enabled: open,
  });
  const t = q.data?.ticket;
  if (q.isError) return <div className="hc-t">Ticket not found</div>;
  if (!t) return <div className="hc-t">Loading</div>;
  const bot = t.assigneeBotId ? dir.bots.get(t.assigneeBotId) : undefined;
  return (
    <>
      <span className="tk">{t.ref}</span>
      <div className="hc-t">{t.title}</div>
      <div className="hc-m">
        <StatusPill status={t.status} />
        <span className="grow" />
        {t.assigneeBotId ? (
          <>
            <Avatar src={bot?.avatarUrl} name={dir.botName(t.assigneeBotId)} size={16} />
            {dir.botName(t.assigneeBotId)}
          </>
        ) : (
          <>
            <UnassignedFace size={16} />
            Unassigned
          </>
        )}
      </div>
    </>
  );
}

/**
 * Hover card of a ticket link (desktop only): opens after 380 ms and loads the ticket only
 * then. `children` is the link element; it becomes the trigger itself.
 */
export function TicketHoverCard({
  ticketRef,
  children,
}: {
  ticketRef: string;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PreviewCard.Root open={open} onOpenChange={setOpen}>
      <PreviewCard.Trigger delay={380} render={children} />
      <PreviewCard.Portal>
        <PreviewCard.Positioner sideOffset={6} style={{ zIndex: 60 }}>
          <PreviewCard.Popup className="hovercard">
            <Body ticketRef={ticketRef} open={open} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
