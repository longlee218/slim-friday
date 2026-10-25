import { useSearchParams } from "react-router";
import { useAppNavigate } from "../shell/use-app-navigate";
import { NewScheduleSheet } from "./new-schedule-sheet";
import { SchedulesPage } from "./schedules-page";

/**
 * `/schedules`: the list of schedules. `?new=1` (New schedule, the palette) opens the
 * new-schedule sheet; closing it drops the parameter, creating opens the new schedule.
 */
export function SchedulesRoute() {
  const [params, setParams] = useSearchParams();
  const go = useAppNavigate();
  const close = () =>
    setParams(
      (p) => {
        p.delete("new");
        return p;
      },
      { replace: true },
    );
  return (
    <>
      <SchedulesPage />
      <NewScheduleSheet
        open={params.get("new") === "1"}
        onOpenChange={(open) => !open && close()}
        onCreated={(s) => go(`/schedules/${s.id}`)}
      />
    </>
  );
}
