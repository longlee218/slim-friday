import type { ApprovalCardDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { ApprovalSheet } from "../chat/approval-sheet";
import { toolLabel } from "../chat/approval-text";
import { PhoneNavBar } from "../phone/phone-nav-bar";
import { useStopRun } from "../shell/use-stop-run";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Pill } from "../ui/pill";
import { wakeTone } from "./activity-math";
import { SpendChart } from "./spend-chart";
import { useActivity, useNow } from "./use-activity";

/**
 * `/ops` on the phone: Working now (with Stop), Waiting for you (open approvals, each opens the
 * review sheet), 7 day Spend and the five latest wakes.
 */
export function PhoneActivityTab() {
  const scroll = useRef<HTMLDivElement>(null);
  const dir = useDirectory();
  const stop = useStopRun();
  const { sessions, wakes, chart } = useActivity(7, useNow());
  const working = sessions.filter((b) => b.working);
  const approvals = useQuery(orpc.approvals.pending.queryOptions()).data ?? [];
  const [review, setReview] = useState<ApprovalCardDto | null>(null);
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
              <Button variant="danger" onClick={() => void stop({ botId: b.botId })}>
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
        {approvals.length > 0 && (
          <>
            <div className="inset-h">Waiting for you</div>
            <div className="inset">
              {approvals.map((a) => {
                const first = Object.values(a.scope)[0];
                return (
                  <button
                    type="button"
                    className="irow ic"
                    key={a.cardId}
                    onClick={() => setReview(a)}
                  >
                    <Avatar src={dir.bots.get(a.botId)?.avatarUrl} name={a.botName} size={30} />
                    <div className="grow">
                      <div>{first ? `${toolLabel(a.tool)} · ${first}` : toolLabel(a.tool)}</div>
                      <div className="t2">{a.botName}</div>
                    </div>
                    <ChevronRight className="chev" />
                  </button>
                );
              })}
            </div>
          </>
        )}
        <div className="inset-h">Spend, 7 days</div>
        <div className="inset">
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
              <Pill tone={wakeTone(w.status)}>{w.status}</Pill>
            </div>
          ))}
        </div>
      </div>
      {review && (
        <ApprovalSheet card={review} open onOpenChange={(open) => !open && setReview(null)} />
      )}
    </>
  );
}
