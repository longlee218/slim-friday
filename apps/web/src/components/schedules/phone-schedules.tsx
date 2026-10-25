import { ChevronRight, Plus } from "lucide-react";
import { Link } from "react-router";
import { useDirectory } from "../../api/directory";
import { SettingsPage } from "../settings/settings-page";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Avatar } from "../ui/avatar";
import { nextRunNote } from "./format-next-run";
import { NEW_SCHEDULE } from "./new-schedule-sheet";
import { ScheduleStatusPill } from "./schedule-status-pill";
import { useSchedules } from "./use-schedules";

/**
 * `/schedules` on the phone (prototype phone `scheds`): pushed from Settings, an inset list of
 * face, name, `when · next`, the status pill and a chevron; a row opens the schedule page, the
 * plus button the new-schedule bottom sheet.
 */
export function PhoneSchedules() {
  const dir = useDirectory();
  const go = useAppNavigate();
  const { schedules, isLoading } = useSchedules();
  const now = Date.now();
  const add = (
    <button type="button" className="nb" aria-label="New schedule" onClick={() => go(NEW_SCHEDULE)}>
      <Plus strokeWidth={1.75} />
    </button>
  );
  return (
    <SettingsPage title="Schedules" inset right={add}>
      <div className="inset sched-inset">
        {!isLoading && schedules.length === 0 && (
          <div className="irow sched-none">
            <div className="grow t2">
              No schedules yet. Ask a bot in chat ("every morning, send me…") or create one here.
            </div>
          </div>
        )}
        {schedules.map((s) => {
          const note = nextRunNote(s, now);
          return (
            <Link key={s.id} className="irow ic" to={`/schedules/${s.id}`}>
              <Avatar
                src={dir.bots.get(s.botId)?.avatarUrl}
                name={dir.botName(s.botId)}
                size={30}
              />
              <div className="grow">
                <div>{s.name}</div>
                <div className="t2">{note ? `${s.when} · ${note}` : s.when}</div>
              </div>
              <ScheduleStatusPill schedule={s} />
              <ChevronRight className="chev" />
            </Link>
          );
        })}
      </div>
      <div className="inset-f">Bots run these on their own and post the result.</div>
    </SettingsPage>
  );
}
