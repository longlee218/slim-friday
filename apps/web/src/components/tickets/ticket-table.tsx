import type { KeyboardEvent } from "react";
import { useDirectory } from "../../api/directory";
import { formatAge } from "../../lib/format";
import { Avatar } from "../ui/avatar";
import type { TicketListProps } from "./ticket-board";
import { StatusPill } from "./ticket-status";
import { UnassignedFace } from "./unassigned-face";

/**
 * List view as a grouped inset list: assignee face, title, `ref · assignee · age`, trailing
 * status. Closed tickets are left out.
 */
export function TicketTable({ tickets, selected, onSelect, onOpen }: TicketListProps) {
  const dir = useDirectory();
  const now = Date.now();
  const onKey = (e: KeyboardEvent, ref: string) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") (selected === ref ? onOpen : onSelect)(ref);
    else if (e.key === " ") onSelect(ref);
    else return;
    e.preventDefault();
  };
  const open = tickets.filter((t) => t.status !== "closed");
  return (
    <div className="tlist" data-bg>
      {open.length === 0 ? (
        <div className="tl-empty">No open tickets.</div>
      ) : (
        <div className="tgroup">
          {open.map((t) => {
            const who = t.assigneeBotId ? dir.botName(t.assigneeBotId) : "Unassigned";
            return (
              // biome-ignore lint/a11y/useSemanticElements: a row with a face and text, not a plain button
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
                {t.assigneeBotId ? (
                  <Avatar src={dir.bots.get(t.assigneeBotId)?.avatarUrl} name={who} size={32} />
                ) : (
                  <UnassignedFace size={32} />
                )}
                <div className="grow">
                  <div className="tt">{t.title}</div>
                  <div className="t2">
                    <span className="tk">{t.ref}</span> · {who} ·{" "}
                    <span className="num">{formatAge(t.updatedAt, now)}</span>
                  </div>
                </div>
                <StatusPill status={t.status} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
