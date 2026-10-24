import { useRef } from "react";
import { useDirectory } from "../../api/directory";
import { PhoneNavBar } from "../phone/phone-nav-bar";
import { useStopRun } from "../shell/use-stop-run";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Pill } from "../ui/pill";
import { wakeBucket } from "./activity-math";
import { SpendChart } from "./spend-chart";
import { useActivity, useNow } from "./use-activity";

/** `/ops` on the phone: Working now (with Stop), 7 day Spend and the five latest wakes. */
export function PhoneActivityTab() {
  const scroll = useRef<HTMLDivElement>(null);
  const dir = useDirectory();
  const stop = useStopRun();
  const { sessions, wakes, chart } = useActivity(7, useNow());
  const working = sessions.filter((b) => b.working);
  return (
    <>
      <PhoneNavBar title="Activity" large scrollRef={scroll} />
      <div className="ios-scroll" ref={scroll}>
        <div className="large">Activity</div>
        <div className="inset-h">Working now</div>
        <div className="inset">
          {working.map((b) => (
            <div className="irow ic" key={b.botId}>
              <Avatar src={dir.bots.get(b.botId)?.avatarUrl} name={b.name} size={30} />
              <div className="grow">
                <div>{b.name}</div>
                <div className="t2">{b.label ?? "Working"}</div>
              </div>
              <Button
                variant="danger"
                style={{ height: 30, borderRadius: 15 }}
                onClick={() => void stop({ botId: b.botId })}
              >
                Stop
              </Button>
            </div>
          ))}
          {working.length === 0 && (
            <div className="irow">
              <div className="grow t2">No bot is working.</div>
            </div>
          )}
        </div>
        <div className="inset-h">Spend, 7 days</div>
        <div className="inset" style={{ padding: "14px 16px" }}>
          <SpendChart days={chart} bare />
        </div>
        <div className="inset-h">Recent wakes</div>
        <div className="inset">
          {wakes.slice(0, 5).map((w) => (
            <div className="irow" key={w.id}>
              <div className="grow">
                <div>
                  {w.sender.kind === "bot" ? dir.botName(w.sender.botId) : "You"} →{" "}
                  {dir.botName(w.targetBot)}
                </div>
                <div className="t2">{w.intent}</div>
              </div>
              <Pill
                tone={
                  wakeBucket(w.status) === "failed"
                    ? "red"
                    : wakeBucket(w.status) === "running"
                      ? "blue"
                      : "green"
                }
              >
                {w.status}
              </Pill>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
