import { List, Plus, SquareKanban } from "lucide-react";
import { useState } from "react";
import { useOpenNewTicket } from "../../app/shell-context";
import { Toolbar } from "../shell/toolbar";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Button } from "../ui/button";
import { TicketBoard } from "./ticket-board";
import { TicketTable } from "./ticket-table";
import { useFreshTickets } from "./use-fresh-tickets";
import { useSelectedTicket, useSelectTicket } from "./use-ticket-selection";
import { openCount, useAllTickets } from "./use-tickets";

/** Board / List switch (prototype `.seg`); the thumb sits under the active button. */
function ViewSwitch({
  view,
  onChange,
}: {
  view: "board" | "list";
  onChange: (v: "board" | "list") => void;
}) {
  return (
    <div className="seg">
      <span
        className="thumb"
        style={{ left: view === "board" ? 2 : "50%", width: "calc(50% - 2px)" }}
      />
      <button
        type="button"
        className={view === "board" ? "on" : ""}
        onClick={() => onChange("board")}
      >
        <SquareKanban size={14} strokeWidth={1.75} />
        Board
      </button>
      <button
        type="button"
        className={view === "list" ? "on" : ""}
        onClick={() => onChange("list")}
      >
        <List size={14} strokeWidth={1.75} />
        List
      </button>
    </div>
  );
}

/**
 * `/tickets` on desktop: toolbar (title with open count, Board / List, New ticket) over the
 * board or the table. A click on a card opens its drawer, a click on the same card or on the
 * background closes it.
 */
export function TicketsPage() {
  const [view, setView] = useState<"board" | "list">("board");
  const { tickets, isLoading } = useAllTickets();
  const fresh = useFreshTickets(tickets, isLoading);
  const selected = useSelectedTicket();
  const select = useSelectTicket();
  const go = useAppNavigate();
  const openNew = useOpenNewTicket();
  const toggle = (ref: string) => select(ref === selected ? null : ref);
  const list = {
    tickets,
    selected,
    fresh,
    onSelect: toggle,
    onOpen: (ref: string) => go(`/tickets/${ref}`),
  };

  return (
    <section className="pane">
      <Toolbar
        title={
          <>
            <span className="sb-ico">
              <SquareKanban strokeWidth={1.75} />
            </span>
            <div>
              <h1>Tickets</h1>
              <div className="st">{openCount(tickets)} open</div>
            </div>
          </>
        }
        actions={
          <>
            <ViewSwitch view={view} onChange={setView} />
            <Button variant="primary" style={{ marginLeft: 8 }} onClick={openNew}>
              <Plus size={14} strokeWidth={1.75} />
              New ticket
            </Button>
          </>
        }
      />
      {/* A click on empty space (not a card, button or field) closes the drawer. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: background click mirrors Esc, the keyboard path */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes the drawer from the keyboard */}
      <div
        className="content"
        data-bg
        onClick={(e) => {
          if (
            selected &&
            !(e.target as HTMLElement).closest("[data-tsel], button, input, textarea, .seg")
          ) {
            select(null);
          }
        }}
      >
        {view === "board" ? <TicketBoard {...list} /> : <TicketTable {...list} />}
      </div>
    </section>
  );
}
