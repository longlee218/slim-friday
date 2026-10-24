import type { TicketPriority, TicketStatus } from "@friday/contracts";
import { Pill } from "../ui/pill";

/** Board columns in order; `closed` is not shown on the board. */
export const TICKET_COLUMNS = ["todo", "doing", "blocked", "review", "done"] as const;

/** Label and dot colour per status (prototype `STATUS`; `closed` is hidden from the board). */
const STATUS: Record<TicketStatus, { name: string; color: string }> = {
  todo: { name: "To do", color: "var(--label-3)" },
  doing: { name: "Doing", color: "var(--tint)" },
  blocked: { name: "Blocked", color: "var(--red-dot)" },
  review: { name: "Review", color: "var(--amber-dot)" },
  done: { name: "Done", color: "var(--green-dot)" },
  closed: { name: "Closed", color: "var(--label-3)" },
};

/** Pill tone and label per priority (prototype `PRIORITY`; `normal` is the prototype's medium). */
const PRIORITY: Record<TicketPriority, { tone: "red" | "amber" | "blue" | "gray"; name: string }> =
  {
    urgent: { tone: "red", name: "Urgent" },
    high: { tone: "amber", name: "High" },
    normal: { tone: "blue", name: "Medium" },
    low: { tone: "gray", name: "Low" },
  };

/** Display name of a status. */
export const statusName = (s: TicketStatus): string => STATUS[s].name;

/** Small coloured dot of a status. */
export function StatusDot({ status }: { status: TicketStatus }) {
  return <span className="sdot" style={{ background: STATUS[status].color }} />;
}

/** Dot plus label of a status. */
export function StatusPill({ status }: { status: TicketStatus }) {
  return (
    <span className="status">
      <StatusDot status={status} />
      {STATUS[status].name}
    </span>
  );
}

/** Priority label as a coloured pill. */
export function PriorityPill({ priority }: { priority: TicketPriority }) {
  const p = PRIORITY[priority];
  return <Pill tone={p.tone}>{p.name}</Pill>;
}
