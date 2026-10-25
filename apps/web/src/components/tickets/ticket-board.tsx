import type { TicketDto } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { TicketCard } from "./ticket-card";
import { StatusDot, statusName, TICKET_COLUMNS } from "./ticket-status";
import { groupByStatus } from "./use-tickets";

export interface TicketListProps {
  tickets: TicketDto[];
  /** Ref of the ticket whose drawer is open. */
  selected: string | null;
  onSelect: (ref: string) => void;
  onOpen: (ref: string) => void;
  /** Ids of tickets that just appeared (entry animation). */
  fresh?: Set<string>;
}

/** Five status columns (dot, name, count) of cards; sideways scroll when the window is narrow. */
export function TicketBoard({ tickets, selected, onSelect, onOpen, fresh }: TicketListProps) {
  const dir = useDirectory();
  const groups = groupByStatus(tickets);
  return (
    <div className="board" data-bg>
      {TICKET_COLUMNS.map((status) => (
        <div className="col" key={status} data-bg>
          <div className="col-h">
            <StatusDot status={status} />
            {statusName(status)}
            <span className="c num">{groups[status].length}</span>
          </div>
          {groups[status].map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              dir={dir}
              selected={selected === t.ref}
              fresh={fresh?.has(t.id)}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
