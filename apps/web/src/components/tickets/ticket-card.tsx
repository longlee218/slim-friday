import type { TicketDto } from "@friday/contracts";
import { MessageSquare, OctagonAlert } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { Directory } from "../../api/directory";
import { formatAge } from "../../lib/format";
import { Avatar } from "../ui/avatar";
import { UnassignedFace } from "./unassigned-face";

export interface TicketCardProps {
  ticket: TicketDto;
  /** Bot names and faces, read once by the board (not per card). */
  dir: Directory;
  /** The card whose drawer is open: 2 px tint ring. */
  selected: boolean;
  /** Created after the board first loaded: plays the entry animation. */
  fresh?: boolean;
  onSelect: (ref: string) => void;
  /** Enter on the selected card: open the full page. */
  onOpen: (ref: string) => void;
}

/** One board card: mono ref, title, assignee face and name, comment count, age, blocked reason. */
export function TicketCard({ ticket: t, dir, selected, fresh, onSelect, onOpen }: TicketCardProps) {
  const bot = t.assigneeBotId ? dir.bots.get(t.assigneeBotId) : undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      (selected ? onOpen : onSelect)(t.ref);
    } else if (e.key === " ") {
      e.preventDefault();
      onSelect(t.ref);
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holds avatars and text, which a button cannot
    <div
      className={["tcard", selected && "on", fresh && "fresh"].filter(Boolean).join(" ")}
      data-tsel={t.ref}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(t.ref)}
      onKeyDown={onKey}
    >
      <div className="ref">{t.ref}</div>
      <div className="tt">{t.title}</div>
      <div className="meta">
        {t.assigneeBotId ? (
          <>
            <Avatar src={bot?.avatarUrl} name={dir.botName(t.assigneeBotId)} size={18} />
            <span>{dir.botName(t.assigneeBotId)}</span>
          </>
        ) : (
          <>
            <UnassignedFace size={18} />
            <span>Unassigned</span>
          </>
        )}
        <span className="grow" />
        {t.commentCount > 0 && (
          <>
            <MessageSquare strokeWidth={1.75} />
            <span className="num">{t.commentCount}</span>
          </>
        )}
        <span>{formatAge(t.updatedAt, Date.now())}</span>
      </div>
      {t.status === "blocked" && t.blockedReason && (
        <div className="meta" style={{ marginTop: 6, color: "var(--red)" }}>
          <OctagonAlert strokeWidth={1.75} />
          {t.blockedReason}
        </div>
      )}
    </div>
  );
}
