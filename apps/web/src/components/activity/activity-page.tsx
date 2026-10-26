import { Gauge } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Toolbar } from "../shell/toolbar";
import { useStopRun } from "../shell/use-stop-run";
import { useSegThumb } from "../ui/use-seg-thumb";
import { LimitMeter } from "./limit-meter";
import { SessionsTable } from "./sessions-table";
import { SpendChart } from "./spend-chart";
import { useActivity, useNow } from "./use-activity";
import { WakesTable } from "./wakes-table";

/** 7 / 30 days switch (`.seg`); the thumb sits under the active button. */
function RangeSwitch({ days, onChange }: { days: 7 | 30; onChange: (d: 7 | 30) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const thumb = useSegThumb(box, days === 7 ? 0 : 1, 2, "");
  return (
    <div ref={box} className="seg">
      <span className="thumb" style={thumb} />
      {([7, 30] as const).map((d) => (
        <button
          type="button"
          key={d}
          className={d === days ? "on" : ""}
          onClick={() => onChange(d)}
        >
          {d} days
        </button>
      ))}
    </div>
  );
}

/**
 * `/ops` on desktop: toolbar with the 7 / 30 day switch over a 1080 px page of Sessions, Spend,
 * Limits and Wakes. A stopped bot reads "stopping" until `ops.sessions` shows it idle.
 */
export function ActivityPage() {
  const [days, setDays] = useState<7 | 30>(7);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const now = useNow();
  const { sessions, wakes, chart, capUsd } = useActivity(days, now);
  const stop = useStopRun();
  const working = sessions.filter((b) => b.working).length;

  // Forget a stop once the refetch shows the bot idle, so a later session is not "stopping".
  useEffect(() => {
    const idle = sessions.filter((b) => !b.working).map((b) => b.botId);
    if (idle.some((id) => stopping.has(id)))
      setStopping(new Set([...stopping].filter((id) => !idle.includes(id))));
  }, [sessions, stopping]);

  return (
    <section className="pane">
      <Toolbar
        title={
          <>
            <span className="sb-ico">
              <Gauge strokeWidth={1.75} />
            </span>
            <div>
              <h1>Activity</h1>
              <div className="st">Last {days} days</div>
            </div>
          </>
        }
        actions={<RangeSwitch days={days} onChange={setDays} />}
      />
      <div className="content">
        <div className="page">
          <h2>
            Sessions
            <span className="aside">
              {working} working · {sessions.length - working} idle
            </span>
          </h2>
          <SessionsTable
            bots={sessions}
            now={now}
            stopping={stopping}
            onStop={(botId) => {
              // Mark "stopping" only once the stop went through; a failed stop keeps the button.
              void stop({ botId }).then((ok) => {
                if (ok) setStopping((s) => new Set(s).add(botId));
              });
            }}
          />
          <div className="grid2">
            <div>
              <h2>Spend</h2>
              <SpendChart days={chart} />
            </div>
            <div>
              <h2>Limits</h2>
              <LimitMeter bots={sessions} capUsd={capUsd} />
            </div>
          </div>
          <WakesTable wakes={wakes} now={now} />
        </div>
      </div>
    </section>
  );
}
