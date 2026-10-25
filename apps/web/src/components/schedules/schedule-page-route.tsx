import { useParams } from "react-router";
import { useIsPhone } from "../../app/use-is-phone";
import { SettingsPage } from "../settings/settings-page";
import { PhoneSchedulePage } from "./phone-schedule-page";
import { SchedulePage } from "./schedule-page";
import { useSchedule } from "./use-schedules";

/** True for the API's "no such schedule" error. */
const isNotFound = (e: unknown): boolean => (e as { code?: string } | null)?.code === "NOT_FOUND";

/**
 * `/schedules/:id`: one schedule (on the phone, a pushed page). A failed refetch keeps the
 * loaded page (so a delete, which refetches before it returns to the list, never flashes "does
 * not exist"); with nothing loaded, a missing schedule and a failed load say different things.
 */
export function SchedulePageRoute() {
  const id = useParams().id ?? "";
  const q = useSchedule(id);
  const phone = useIsPhone();
  if (q.data) {
    const s = q.data.schedule;
    return phone ? (
      <PhoneSchedulePage key={id} schedule={s} />
    ) : (
      <SchedulePage key={id} schedule={s} />
    );
  }
  const empty = q.isError && (
    <div className="empty">
      <h3>
        {isNotFound(q.error) ? "This schedule does not exist." : "Could not load the schedule."}
      </h3>
    </div>
  );
  if (phone) return <SettingsPage title="Schedule">{empty}</SettingsPage>;
  return (
    <div className="content">
      <div className="page">{empty}</div>
    </div>
  );
}
