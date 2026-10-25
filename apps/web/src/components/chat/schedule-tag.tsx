import { CalendarClock } from "lucide-react";
import { Link } from "react-router";
import { useSchedules } from "../schedules/use-schedules";

/** The schedule a message came from, as the message stored it. */
export interface ScheduleRef {
  id: string;
  name: string;
}

/**
 * Says which schedule posted a message (prototype `schedTag`): clock icon and name. It opens
 * `/schedules/<id>` only while the schedule `exists`; a deleted one is muted plain text.
 * `undefined` means not known yet (list loading or failed): the plain name, never marked gone.
 */
export function ScheduleTag({
  schedule,
  exists,
}: {
  schedule: ScheduleRef;
  exists: boolean | undefined;
}) {
  const body = (
    <>
      <CalendarClock strokeWidth={2} aria-hidden />
      {schedule.name}
    </>
  );
  if (exists === undefined) return <span className="sched-tag">{body}</span>;
  if (!exists) return <span className="sched-tag gone">{body}</span>;
  return (
    <Link
      className="sched-tag"
      to={`/schedules/${schedule.id}`}
      aria-label={`Schedule ${schedule.name}`}
    >
      {body}
    </Link>
  );
}

/** The tag of a bot message, checked against the schedules list once it has loaded. */
export function MessageScheduleTag({ schedule }: { schedule: ScheduleRef }) {
  const { schedules, loaded } = useSchedules();
  const exists = loaded ? schedules.some((s) => s.id === schedule.id) : undefined;
  return <ScheduleTag schedule={schedule} exists={exists} />;
}
