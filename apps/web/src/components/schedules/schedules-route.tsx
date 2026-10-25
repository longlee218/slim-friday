import { CalendarClock } from "lucide-react";
import { enabledCount, useSchedules } from "./use-schedules";

/**
 * `/schedules`: the list of schedules. Placeholder until the list page lands (Task 5); the palette
 * opens it as `/schedules?new=1`, which Task 6 reads to open the new-schedule sheet.
 */
export function SchedulesRoute() {
  const { schedules, isLoading } = useSchedules();
  return (
    <div className="content">
      <div className="page">
        <h1>
          <CalendarClock size={18} strokeWidth={1.75} /> Schedules
        </h1>
        {isLoading ? null : schedules.length === 0 ? (
          <p className="empty">No schedules yet.</p>
        ) : (
          <p>{`${enabledCount(schedules)} on of ${schedules.length}`}</p>
        )}
      </div>
    </div>
  );
}
