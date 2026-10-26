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

/**
 * Sessions as a grouped list: face, name, what it is doing and for how long, today's spend, the
 * state pill (working / idle / stopping) and Stop.
 */
export function SessionsTable({ bots, now, stopping, onStop }: SessionsTableProps) {
  const dir = useDirectory();
  return (
    <div className="panel">
      {bots.map((b) => {
        const stop = b.working && stopping.has(b.botId);
        const since =
          b.working && b.startedAt !== undefined ? formatDuration(now - b.startedAt) : null;
        return (
          <div className="arow" key={b.botId}>
            <Avatar
              src={dir.bots.get(b.botId)?.avatarUrl}
              name={b.name}
              size={32}
              working={b.working && !stop}
            />
            <div className="grow">
              <div className="t1">{b.name}</div>
              <div className="t2">
                {b.working ? (b.label ?? "Working") : "No session"}
                {since && (
                  <>
                    {" · "}
                    <span className="num">{since}</span>
                  </>
                )}
              </div>
            </div>
            <span className="a-cost num" title="Spent today">
              {formatCost(b.spendToday)}
            </span>
            <Pill tone={stop ? "amber" : b.working ? "blue" : "gray"}>
              {stop ? "stopping" : b.working ? "working" : "idle"}
            </Pill>
            {b.working && (
              <IconButton label={`Stop ${b.name}`} disabled={stop} onClick={() => onStop(b.botId)}>
                <CircleStop size={16} strokeWidth={1.75} />
              </IconButton>
            )}
          </div>
        );
      })}
      {bots.length === 0 && <div className="arow t2">No bots yet.</div>}
    </div>
  );
}
