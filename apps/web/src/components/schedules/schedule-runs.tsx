import type { ScheduleDto, ScheduleRunDto } from "@friday/contracts";
import { Link } from "react-router";
import { formatCost, formatDuration } from "../../lib/format";
import { Button } from "../ui/button";
import { RunStatusPill } from "./schedule-status-pill";
import { useScheduleRuns } from "./use-schedules";

/** When a run fired, on the schedule's own clock: `Sat 25 Oct, 07:30`. */
const firedText = (at: number, timeZone: string): string =>
  new Date(at).toLocaleString("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

/** One history row (prototype `.srow`): pill, when (and how), error, length, cost. */
function RunRow({ run: r, schedule: s }: { run: ScheduleRunDto; schedule: ScheduleDto }) {
  const how = [r.manual && "run now", r.late && "late"].filter(Boolean).join(", ");
  const body = (
    <>
      <RunStatusPill status={r.status} />
      <div className="grow">
        <b>{firedText(r.firedAt, s.timeZone)}</b>
        {how && <span className="t2"> · {how}</span>}
        {r.error && <div className="t2 sched-run-err">{r.error}</div>}
      </div>
      <span className="t2 num">
        {r.endedAt !== undefined ? formatDuration(r.endedAt - r.firedAt) : ""}
      </span>
      <span className="t2 num sched-run-cost">{formatCost(r.costUsd)}</span>
    </>
  );
  // The result message lives in the chat; the chat has no message anchor, so the link opens it.
  return r.messageId !== undefined ? (
    <Link className="srow sched-run" to={`/c/${s.conversationId}`}>
      {body}
    </Link>
  ) : (
    <div className="srow">{body}</div>
  );
}

/** "Recent runs" of a schedule, newest first; Load more fetches the next 20. */
export function ScheduleRuns({ schedule: s }: { schedule: ScheduleDto }) {
  const q = useScheduleRuns(s.id);
  const runs = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isLoading) return null;
  return (
    <div className="list-panel sched-runs">
      {runs.map((r) => (
        <RunRow key={r.id} run={r} schedule={s} />
      ))}
      {runs.length === 0 && (
        <div className="srow">
          <div className="grow t2">{q.isError ? "Could not load the runs." : "No runs yet."}</div>
        </div>
      )}
      {q.hasNextPage && (
        <div className="add-row">
          <Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
