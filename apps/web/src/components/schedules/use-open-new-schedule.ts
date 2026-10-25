import { useLocation } from "react-router";
import { useAppNavigate } from "../shell/use-app-navigate";
import { NEW_SCHEDULE } from "./new-schedule-sheet";

/**
 * Opens the new-schedule sheet (`/schedules?new=1`). On `/schedules` it replaces the entry: a
 * pushed `?new=1` has the same path, so the phone stack would ignore it and the next Back would
 * do nothing. Elsewhere (the palette) it pushes, so Back returns to where it was opened.
 */
export function useOpenNewSchedule(): () => void {
  const go = useAppNavigate();
  const { pathname } = useLocation();
  return () => go(NEW_SCHEDULE, { replace: pathname === "/schedules" });
}
