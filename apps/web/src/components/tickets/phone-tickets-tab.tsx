import type { TicketDto, TicketStatus } from "@friday/contracts";
import { ChevronRight, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useDirectory } from "../../api/directory";
import { useOpenNewTicket } from "../../app/shell-context";
import { PhoneNavBar } from "../phone/phone-nav-bar";
import { Avatar } from "../ui/avatar";
import { statusName } from "./ticket-status";
import { UnassignedFace } from "./unassigned-face";
import { useAllTickets } from "./use-tickets";

/** The three segments of the phone tab. */
export type PhoneSegment = "open" | "review" | "done";

const SEGMENTS: { id: PhoneSegment; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "review", label: "To review" },
  { id: "done", label: "Done" },
];

/** Statuses shown (as sections, in order) under each segment. */
const SECTIONS: Record<PhoneSegment, TicketStatus[]> = {
  open: ["todo", "doing", "blocked"],
  review: ["review"],
  done: ["done"],
};

/** The segment a ticket belongs to; a closed ticket is in none. */
export function phoneSegment(t: TicketDto): PhoneSegment | null {
  switch (t.status) {
    case "todo":
    case "doing":
    case "blocked":
      return "open";
    case "review":
      return "review";
    case "done":
      return "done";
    case "closed":
      return null;
  }
}

/** One 44 px row: assignee face, ref in mono tint, title, chevron. Opens the pushed ticket view. */
function TicketRow({ ticket: t }: { ticket: TicketDto }) {
  const dir = useDirectory();
  const navigate = useNavigate();
  const bot = t.assigneeBotId ? dir.bots.get(t.assigneeBotId) : undefined;
  return (
    <a
      className="irow ic"
      href={`/tickets/${t.ref}`}
      onClick={(e) => {
        e.preventDefault();
        void navigate(`/tickets/${t.ref}`);
      }}
    >
      {t.assigneeBotId ? (
        <Avatar src={bot?.avatarUrl} name={dir.botName(t.assigneeBotId)} size={30} />
      ) : (
        <UnassignedFace size={30} />
      )}
      <div className="grow">
        <div>
          <span className="tk">{t.ref}</span>
        </div>
        <div style={{ fontSize: 15 }}>{t.title}</div>
      </div>
      <ChevronRight className="chev" strokeWidth={1.75} />
    </a>
  );
}

/**
 * `/tickets` on the phone: large title, `+` (new ticket sheet), the Open / To review / Done
 * segments and inset lists grouped by status (Open shows To do, Doing and Blocked).
 */
export function PhoneTicketsTab() {
  const openNew = useOpenNewTicket();
  const { tickets, isLoading } = useAllTickets();
  const [segment, setSegment] = useState<PhoneSegment>("open");
  const scroll = useRef<HTMLDivElement>(null);
  const index = SEGMENTS.findIndex((s) => s.id === segment);
  const inSegment = tickets.filter((t) => phoneSegment(t) === segment);
  const sections = SECTIONS[segment]
    .map((status) => ({ status, items: inSegment.filter((t) => t.status === status) }))
    .filter((s) => s.items.length > 0);

  return (
    <>
      <PhoneNavBar
        title="Tickets"
        large
        scrollRef={scroll}
        right={
          <button type="button" className="nb" aria-label="New ticket" onClick={openNew}>
            <Plus strokeWidth={1.75} />
          </button>
        }
      />
      <div className="ios-scroll" ref={scroll}>
        <div className="large">Tickets</div>
        <div className="ios-seg">
          <div className="seg">
            {/* The thumb is one third of the track, moved under the active button. */}
            <span
              className="thumb"
              style={{
                left: `calc(2px + ${index} * (100% - 4px) / 3)`,
                width: "calc((100% - 4px) / 3)",
              }}
            />
            {SEGMENTS.map((s) => (
              <button
                type="button"
                key={s.id}
                className={s.id === segment ? "on" : ""}
                onClick={() => setSegment(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {sections.map(({ status, items }) => (
          <div key={status}>
            <div className="inset-h">{statusName(status)}</div>
            <div className="inset">
              {items.map((t) => (
                <TicketRow key={t.id} ticket={t} />
              ))}
            </div>
          </div>
        ))}
        {sections.length === 0 && !isLoading && (
          <div className="empty" style={{ position: "relative" }}>
            <h3>Nothing here.</h3>
          </div>
        )}
      </div>
    </>
  );
}
