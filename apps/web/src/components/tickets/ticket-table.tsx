import type { KeyboardEvent } from "react";
import { useDirectory } from "../../api/directory";
import { formatAge } from "../../lib/format";
import { Avatar } from "../ui/avatar";
import type { TicketListProps } from "./ticket-board";
import { StatusPill } from "./ticket-status";

/** List view: Ref, Title, Status, Assignee, Updated; every other row striped. Closed tickets are left out. */
export function TicketTable({ tickets, selected, onSelect, onOpen }: TicketListProps) {
  const dir = useDirectory();
  const now = Date.now();
  const onKey = (e: KeyboardEvent, ref: string) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") onOpen(ref);
    else if (e.key === " ") onSelect(ref);
    else return;
    e.preventDefault();
  };
  return (
    <div className="tlist" data-bg>
      <div className="trow h">
        <span>Ref</span>
        <span>Title</span>
        <span>Status</span>
        <span>Assignee</span>
        <span>Updated</span>
      </div>
      {tickets
        .filter((t) => t.status !== "closed")
        .map((t) => (
          // biome-ignore lint/a11y/useSemanticElements: a grid row, not a button
          <div
            key={t.id}
            className={selected === t.ref ? "trow on" : "trow"}
            data-tsel={t.ref}
            role="button"
            tabIndex={0}
            aria-pressed={selected === t.ref}
            onClick={() => onSelect(t.ref)}
            onKeyDown={(e) => onKey(e, t.ref)}
          >
            <span className="tk">{t.ref}</span>
            <span>{t.title}</span>
            <StatusPill status={t.status} />
            <span className="who-cell">
              {t.assigneeBotId ? (
                <>
                  <Avatar
                    src={dir.bots.get(t.assigneeBotId)?.avatarUrl}
                    name={dir.botName(t.assigneeBotId)}
                    size={20}
                  />
                  {dir.botName(t.assigneeBotId)}
                </>
              ) : (
                "—"
              )}
            </span>
            <span className="num" style={{ color: "var(--label-2)" }}>
              {formatAge(t.updatedAt, now)}
            </span>
          </div>
        ))}
    </div>
  );
}
