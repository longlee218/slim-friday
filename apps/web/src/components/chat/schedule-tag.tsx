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
 * `/schedules/<id>` only while the schedule `exists`; a deleted one stays as plain text.
 */
export function ScheduleTag({ schedule, exists }: { schedule: ScheduleRef; exists: boolean }) {
  const body = (
    <>
      <CalendarClock strokeWidth={2} aria-hidden />
      {schedule.name}
    </>
  );
  if (!exists) return <span className="sched-tag gone">{body}</span>;
  return (
    <Link className="sched-tag" to={`/schedules/${schedule.id}`}>
      {body}
    </Link>
  );
}

/** The tag of a bot message, checked against the schedules list. */
export function MessageScheduleTag({ schedule }: { schedule: ScheduleRef }) {
  const { schedules } = useSchedules();
  return <ScheduleTag schedule={schedule} exists={schedules.some((s) => s.id === schedule.id)} />;
}
