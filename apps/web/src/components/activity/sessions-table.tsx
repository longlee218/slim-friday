import type { BotStatusDto } from "@friday/contracts";
import { CircleStop } from "lucide-react";
import { useDirectory } from "../../api/directory";
import { formatCost, formatDuration } from "../../lib/format";
import { Avatar } from "../ui/avatar";
import { IconButton } from "../ui/button";
import { Pill } from "../ui/pill";

export interface SessionsTableProps {
  bots: BotStatusDto[];
  now: number;
  /** Bots the owner stopped that the next `ops.sessions` refetch still shows working. */
  stopping: ReadonlySet<string>;
  onStop: (botId: string) => void;
}

/** Sessions: Bot, State (working / idle / stopping), Now, Session length, Today, Stop. */
export function SessionsTable({ bots, now, stopping, onStop }: SessionsTableProps) {
  const dir = useDirectory();
  return (
    <div className="panel">
      <table className="table">
        <thead>
          <tr>
            <th>Bot</th>
            <th>State</th>
            <th>Now</th>
            <th className="r">Session</th>
            <th className="r">Today</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {bots.map((b) => {
            const stop = b.working && stopping.has(b.botId);
            return (
              <tr key={b.botId}>
                <td>
                  <span className="who-cell">
                    <Avatar src={dir.bots.get(b.botId)?.avatarUrl} name={b.name} size={22} />
                    <b>{b.name}</b>
                  </span>
                </td>
                <td>
                  <Pill tone={stop ? "amber" : b.working ? "blue" : "gray"}>
                    {stop ? "stopping" : b.working ? "working" : "idle"}
                  </Pill>
                </td>
                <td style={{ color: "var(--label-2)" }}>{b.working ? (b.label ?? "—") : "—"}</td>
                <td className="r num">
                  {b.working && b.startedAt !== undefined ? formatDuration(now - b.startedAt) : "—"}
                </td>
                <td className="r num">{formatCost(b.spendToday)}</td>
                <td className="r">
                  {b.working && (
                    <IconButton
                      label={`Stop ${b.name}`}
                      disabled={stop}
                      onClick={() => onStop(b.botId)}
                    >
                      <CircleStop size={16} strokeWidth={1.75} />
                    </IconButton>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
