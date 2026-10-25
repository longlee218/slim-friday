import type { TicketPriority, TicketStatus } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { Avatar } from "../ui/avatar";
import { TicketSelect, type TicketSelectOption } from "./ticket-select";
import { PriorityPill, StatusPill } from "./ticket-status";
import { UnassignedFace } from "./unassigned-face";

const STATUSES: TicketStatus[] = ["todo", "doing", "blocked", "review", "done"];
const PRIORITIES: TicketPriority[] = ["urgent", "high", "normal", "low"];

/** Status select over the five board statuses; `closed` is set only by Close ticket. */
export function StatusSelect({
  value,
  onChange,
}: {
  value: TicketStatus;
  onChange: (s: TicketStatus) => void;
}) {
  const options: TicketSelectOption<TicketStatus>[] = STATUSES.map((s) => ({
    value: s,
    node: <StatusPill status={s} />,
  }));
  return (
    <TicketSelect
      label="Status"
      value={value}
      options={options}
      current={<StatusPill status={value} />}
      onChange={onChange}
    />
  );
}

/** Priority select (urgent to low). */
export function PrioritySelect({
  value,
  onChange,
}: {
  value: TicketPriority;
  onChange: (p: TicketPriority) => void;
}) {
  const options: TicketSelectOption<TicketPriority>[] = PRIORITIES.map((p) => ({
    value: p,
    node: <PriorityPill priority={p} />,
  }));
  return (
    <TicketSelect
      label="Priority"
      value={value}
      options={options}
      current={<PriorityPill priority={value} />}
      onChange={onChange}
    />
  );
}

/** Assignee select over the bot directory; `value` null shows "Unassigned" (there is no unassign). */
export function AssigneeSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (botId: string) => void;
}) {
  const dir = useDirectory();
  const options: TicketSelectOption<string>[] = [...dir.bots.values()].map((b) => ({
    value: b.id,
    node: (
      <>
        <Avatar src={b.avatarUrl} name={b.name} size={18} />
        {b.name}
      </>
    ),
  }));
  const bot = value ? dir.bots.get(value) : undefined;
  return (
    <TicketSelect
      label="Assignee"
      value={value}
      options={options}
      onChange={onChange}
      current={
        value ? (
          <>
            <Avatar src={bot?.avatarUrl} name={dir.botName(value)} size={16} />
            {dir.botName(value)}
          </>
        ) : (
          <>
            <UnassignedFace size={16} />
            Unassigned
          </>
        )
      }
    />
  );
}
