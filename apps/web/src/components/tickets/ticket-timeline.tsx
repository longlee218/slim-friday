import {
  type TicketEventDto,
  TicketPrioritySchema,
  TicketStatusSchema,
  type TicketTimelineItemDto,
} from "@friday/contracts";
import { ArrowRightLeft, CircleDot, CirclePlus, Flag } from "lucide-react";
import type { ReactElement } from "react";
import { type Directory, useDirectory } from "../../api/directory";
import { formatClock } from "../../lib/format";
import { TicketComment } from "./ticket-comments";
import { priorityName, statusName } from "./ticket-status";

/** Who did it: the owner is "You", the system is "Friday", a bot is its name. */
function actorName(e: TicketEventDto, dir: Directory): string {
  if (e.actor.kind === "bot") return dir.botName(e.actor.botId);
  return e.actor.kind === "user" ? "You" : "Friday";
}

/** Display name of the status in `to`; the raw value when it is not a known status. */
function statusLabel(to: string): string {
  const s = TicketStatusSchema.safeParse(to);
  return s.success ? statusName(s.data) : to;
}

/** Display name of the priority in `to`; the raw value when it is not a known priority. */
function priorityLabel(to: string): string {
  const p = TicketPrioritySchema.safeParse(to);
  return p.success ? priorityName(p.data) : to;
}

/** Icon and sentence of one change; `to` carries the new status, priority or bot id. */
function describe(e: TicketEventDto, dir: Directory): { icon: ReactElement; text: string } {
  const who = actorName(e, dir);
  const to = e.to ?? "";
  switch (e.kind) {
    case "created":
      return {
        icon: <CirclePlus />,
        text: `${who} created the ticket${to ? ` and assigned it to ${dir.botName(to)}` : ""}`,
      };
    case "status":
      return { icon: <CircleDot />, text: `${who} moved it to ${statusLabel(to)}` };
    case "assignee":
      return { icon: <ArrowRightLeft />, text: `${who} assigned it to ${dir.botName(to)}` };
    case "handoff":
      return { icon: <ArrowRightLeft />, text: `${who} handed it off to ${dir.botName(to)}` };
    case "priority":
      return { icon: <Flag />, text: `${who} set priority to ${priorityLabel(to)}` };
  }
}

/**
 * Activity of a ticket on a hairline rail, in the order the server sends: changes are small icon
 * lines with the time, comments are cards.
 */
export function TicketTimeline({ items }: { items: TicketTimelineItemDto[] }) {
  const dir = useDirectory();
  const now = Date.now();
  return (
    <div className="tlog">
      {items.map((item) => {
        if (item.type === "comment")
          return <TicketComment key={item.comment.id} comment={item.comment} />;
        const { icon, text } = describe(item.event, dir);
        return (
          <div className="tev" key={item.event.id}>
            {icon}
            <span>{text}</span>
            <time>{formatClock(item.event.at, now)}</time>
          </div>
        );
      })}
    </div>
  );
}
