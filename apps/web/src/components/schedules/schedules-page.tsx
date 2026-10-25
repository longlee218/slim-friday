import { CalendarClock, Plus } from "lucide-react";
import { useIsPhone } from "../../app/use-is-phone";
import { Toolbar } from "../shell/toolbar";
import { Button } from "../ui/button";
import { PhoneSchedules } from "./phone-schedules";
import { ScheduleRow } from "./schedule-row";
import { useOpenNewSchedule } from "./use-open-new-schedule";
import { enabledCount, useSchedules } from "./use-schedules";

/** The rows (or the empty state) and the footnote. */
function SchedulesBody() {
  const { schedules, isLoading } = useSchedules();
  if (isLoading) return null;
  return (
    <>
      {schedules.length === 0 ? (
        <div className="sched-empty">
          No schedules yet. Ask a bot in chat ("every morning, send me…") or create one here.
        </div>
      ) : (
        <div className="panel sched-list">
          {schedules.map((s) => (
            <ScheduleRow key={s.id} schedule={s} />
          ))}
        </div>
      )}
      <div className="foot-note sched-note">
        A scheduled run is a normal turn: it uses the bot's tools and memory, counts toward its
        daily spend limit and posts where you chose. Missed runs (Friday was off) run once when it
        starts again.
      </div>
    </>
  );
}

/**
 * `/schedules` (prototype `schedulesView`): toolbar with the on count and New schedule over the
 * list and its footnote. Below 720 px the list becomes an inset list (CSS); on the phone it is
 * `PhoneSchedules`, pushed from Settings.
 */
export function SchedulesPage() {
  const { schedules } = useSchedules();
  const openNew = useOpenNewSchedule();
  if (useIsPhone()) return <PhoneSchedules />;
  return (
    <section className="pane">
      <Toolbar
        title={
          <>
            <span className="sb-ico">
              <CalendarClock strokeWidth={1.75} />
            </span>
            <div>
              <h1>Schedules</h1>
              <div className="st">{enabledCount(schedules)} on · bots run these on their own</div>
            </div>
          </>
        }
        actions={
          <Button variant="primary" onClick={() => openNew()}>
            <Plus size={14} strokeWidth={1.75} />
            New schedule
          </Button>
        }
      />
      <div className="content">
        <div className="page sched-page-list">
          <SchedulesBody />
        </div>
      </div>
    </section>
  );
}
