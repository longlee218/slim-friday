import { useParams } from "react-router";
import { useSchedule } from "./use-schedules";

/** `/schedules/:id`: one schedule. Placeholder until the detail page lands (Task 6). */
export function SchedulePageRoute() {
  const id = useParams().id ?? "";
  const q = useSchedule(id);
  return (
    <div className="content">
      <div className="page">
        {q.isLoading ? null : q.data ? (
          <h1>{q.data.schedule.name}</h1>
        ) : (
          <p className="empty">Schedule not found.</p>
        )}
      </div>
    </div>
  );
}
