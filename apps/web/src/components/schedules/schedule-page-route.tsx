import { useParams } from "react-router";
import { SchedulePage } from "./schedule-page";
import { useSchedule } from "./use-schedules";

/** True for the API's "no such schedule" error. */
const isNotFound = (e: unknown): boolean => (e as { code?: string } | null)?.code === "NOT_FOUND";

/**
 * `/schedules/:id`: one schedule. A failed refetch keeps the loaded page (so a delete, which
 * refetches before it returns to the list, never flashes "does not exist"); with nothing
 * loaded, a missing schedule and a failed load say different things.
 */
export function SchedulePageRoute() {
  const id = useParams().id ?? "";
  const q = useSchedule(id);
  if (q.data) return <SchedulePage key={id} schedule={q.data.schedule} />;
  return (
    <div className="content">
      <div className="page">
        {q.isError && (
          <div className="empty">
            <h3>
              {isNotFound(q.error)
                ? "This schedule does not exist."
                : "Could not load the schedule."}
            </h3>
          </div>
        )}
      </div>
    </div>
  );
}
