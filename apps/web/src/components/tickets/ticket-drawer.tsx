import type { TicketDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, X } from "lucide-react";
import { useState } from "react";
import { orpc } from "../../api/client";
import { BotMarkdown } from "../markdown/bot-markdown";
import { InspectorSection } from "../shell/inspector";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Button, IconButton } from "../ui/button";
import { TicketComment } from "./ticket-comments";
import { TicketDetail } from "./ticket-detail";
import { useCommentTicket } from "./use-comment-ticket";
import { useAllTickets } from "./use-tickets";
import { useUpdateTicket } from "./use-update-ticket";

export interface TicketDrawerProps {
  /** Ref of the open ticket. */
  ticketRef: string;
  /** Closes the drawer (the ×, Esc and the board background do the same). */
  onClose: () => void;
}

/** Latest comments (two) and the comment box of a ticket. */
function Latest({ ticket, onClose }: { ticket: TicketDto; onClose: () => void }) {
  const get = useQuery(orpc.tickets.get.queryOptions({ input: { ref: ticket.ref } }));
  const comment = useCommentTicket(ticket.ref);
  const update = useUpdateTicket();
  const [text, setText] = useState("");
  const comments = (get.data?.timeline ?? []).flatMap((i) =>
    i.type === "comment" ? [i.comment] : [],
  );
  const send = () => {
    const body = text.trim();
    if (!body) return;
    comment.mutate(body, { onSuccess: () => setText("") });
  };
  return (
    <InspectorSection title="Latest">
      {comments.slice(-2).map((c) => (
        <TicketComment key={c.id} comment={c} />
      ))}
      {comments.length === 0 && <div style={{ color: "var(--label-2)" }}>No comments yet.</div>}
      <textarea
        className="field"
        rows={2}
        placeholder="Comment"
        aria-label="Comment"
        style={{ marginTop: 8 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <Button
          variant="danger"
          onClick={() => {
            update.mutate({ ref: ticket.ref, status: "closed" });
            onClose();
          }}
        >
          Close ticket
        </Button>
        <Button variant="primary" disabled={!text.trim() || comment.isPending} onClick={send}>
          Comment
        </Button>
      </div>
    </InspectorSection>
  );
}

/**
 * Right-column drawer of a ticket (prototype inspector ticket branch): ref, title, the shared
 * property rows, a clamped description, the last two comments and a comment box. Close ticket
 * sets status `closed`, which drops the card from the board and closes the drawer.
 */
export function TicketDrawer({ ticketRef, onClose }: TicketDrawerProps) {
  const go = useAppNavigate();
  const { tickets, isLoading } = useAllTickets();
  const t = tickets.find((x) => x.ref === ticketRef);
  const open = () => go(`/tickets/${ticketRef}`);
  return (
    <>
      <IconButton className="insp-close" label="Close (Esc)" onClick={onClose}>
        <X strokeWidth={1.75} />
      </IconButton>
      <IconButton className="insp-open" label="Open full page (↩)" onClick={open}>
        <Maximize2 strokeWidth={1.75} />
      </IconButton>
      <div className="insp-in">
        <div className="td-ref">{ticketRef}</div>
        {t ? (
          <>
            <div className="td-title">{t.title}</div>
            <div className="insp-sec" style={{ paddingTop: 0 }}>
              <TicketDetail ticket={t} />
            </div>
            <InspectorSection title="Description">
              <div className="td-desc clamp">
                <BotMarkdown text={t.description || "No description."} />
              </div>
              <button type="button" className="linkbtn" onClick={open}>
                Open full ticket
              </button>
            </InspectorSection>
            <Latest ticket={t} onClose={onClose} />
          </>
        ) : (
          <div className="td-title">{isLoading ? "Loading" : "Closed or gone."}</div>
        )}
      </div>
    </>
  );
}
