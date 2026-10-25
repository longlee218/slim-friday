import { CalendarClock, Plus } from "lucide-react";
import { useRef } from "react";
import { useIsPhone } from "../../app/use-is-phone";
import { PhoneNavBar } from "../phone/phone-nav-bar";
import { Toolbar } from "../shell/toolbar";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Button } from "../ui/button";
import { ScheduleRow } from "./schedule-row";
import { enabledCount, useSchedules } from "./use-schedules";

/** `?new=1` is the contract with the new-schedule sheet, which opens from it. */
const NEW_SCHEDULE = "/schedules?new=1";

/** The rows (or the empty state) and the footnote; the same body on desktop and phone. */
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

/** Phone frame: large-title nav bar with a New schedule button over the scroll body. */
function PhoneSchedules() {
  const scroll = useRef<HTMLDivElement>(null);
  const go = useAppNavigate();
  return (
    <>
      <PhoneNavBar
        title="Schedules"
        large
        scrollRef={scroll}
        right={
          <button
            type="button"
            className="nb"
            aria-label="New schedule"
            onClick={() => go(NEW_SCHEDULE)}
          >
            <Plus strokeWidth={1.75} />
          </button>
        }
      />
      <div className="ios-scroll" ref={scroll}>
        <div className="large">Schedules</div>
        <SchedulesBody />
      </div>
    </>
  );
}

/**
 * `/schedules` (prototype `schedulesView`): toolbar with the on count and New schedule over the
 * list and its footnote. Below 720 px the list becomes an inset list (CSS); below 640 px the
 * phone nav bar replaces the toolbar.
 */
export function SchedulesPage() {
  const { schedules } = useSchedules();
  const go = useAppNavigate();
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
          <Button variant="primary" onClick={() => go(NEW_SCHEDULE)}>
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
