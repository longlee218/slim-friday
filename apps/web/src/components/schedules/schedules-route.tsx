import { SchedulesPage } from "./schedules-page";

/**
 * `/schedules`: the list of schedules. The palette and New schedule open it as
 * `/schedules?new=1`, which the new-schedule sheet (Task 6) reads.
 */
export function SchedulesRoute() {
  return <SchedulesPage />;
}
