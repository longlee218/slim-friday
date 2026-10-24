import type { ApprovalCardDto, BotStatusDto } from "@friday/contracts";
import { CircleStop, MessageCircle } from "lucide-react";
import { formatCost, formatDuration } from "../../lib/format";
import { countdown, useNow } from "../chat/countdown";
import { Avatar } from "../ui/avatar";
import { IconButton } from "../ui/button";
import { Pill } from "../ui/pill";
import { useAppNavigate } from "./use-app-navigate";
import { useStopRun } from "./use-stop-run";

export interface ActivityPopoverProps {
  status: BotStatusDto[];
  approvals: ApprovalCardDto[];
  avatarOf: (botId: string) => string | undefined;
  /** Closes the popover (after a navigation). */
  onClose: () => void;
}

/**
 * Body of the capsule popover: who is working (open chat, stop), what waits for the owner
 * (with the auto-deny countdown when the card has an expiry) and a link to Activity.
 */
export function ActivityPopover({ status, approvals, avatarOf, onClose }: ActivityPopoverProps) {
  const go = useAppNavigate();
  const stop = useStopRun();
  const now = useNow();
  const working = status.filter((s) => s.working);

  const open = (to: string) => {
    onClose();
    go(to);
  };
  return (
    <>
      <div className="pop-h">
        <span>Working now</span>
        <span className="num">
          {formatCost(status.reduce((s, b) => s + b.spendToday, 0))} today
        </span>
      </div>
      {working.map((b) => (
        <div className="task" key={b.botId}>
          <Avatar src={avatarOf(b.botId)} name={b.name} size={28} />
          <div className="grow">
            <div className="t1">{b.name}</div>
            <div className="t2">
              {b.label}
              {b.startedAt !== undefined && (
                <>
                  {b.label ? " · " : ""}
                  <span className="num">{formatDuration(now - b.startedAt)}</span>
                </>
              )}
            </div>
          </div>
          <IconButton label="Open chat" onClick={() => open(`/c/bot:${b.botId}`)}>
            <MessageCircle size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton label={`Stop ${b.name}`} onClick={() => void stop({ botId: b.botId })}>
            <CircleStop size={16} strokeWidth={1.75} />
          </IconButton>
        </div>
      ))}
      {working.length === 0 && (
        <div className="task">
          <div className="grow t2">No bot is working.</div>
        </div>
      )}
      {approvals.length > 0 && (
        <>
          <div className="pop-sep" />
          <div className="pop-h">
            <span>Waiting for you</span>
          </div>
          {approvals.map((a) => {
            const first = Object.values(a.scope)[0];
            return (
              <a
                className="task"
                key={a.cardId}
                href={`/c/${a.conversationId}`}
                onClick={(e) => {
                  e.preventDefault();
                  open(`/c/${a.conversationId}`);
                }}
              >
                <Avatar src={avatarOf(a.botId)} name={a.botName} size={28} />
                <div className="grow">
                  <div className="t1">{first ? `${a.tool} · ${first}` : a.tool}</div>
                  <div className="t2">
                    {a.botName}
                    {a.expiresAt !== undefined && ` · ${countdown(a.expiresAt, now)}`}
                  </div>
                </div>
                <Pill tone="amber">Review</Pill>
              </a>
            );
          })}
        </>
      )}
      <div className="pop-sep" />
      <a
        className="task"
        href="/ops"
        onClick={(e) => {
          e.preventDefault();
          open("/ops");
        }}
      >
        <div className="grow">Open Activity</div>
        <span className="t2">⌘3</span>
      </a>
    </>
  );
}
