import type { ScheduleDto } from "@friday/contracts";
import { Play, Repeat } from "lucide-react";
import { Link } from "react-router";
import { type Directory, useDirectory } from "../../api/directory";
import { Switch } from "../settings/form-parts";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { formatNextRun } from "./format-next-run";
import { ScheduleStatusPill } from "./schedule-status-pill";
import { conversationName } from "./schedule-target";
import { useRunNow, useScheduleSwitch } from "./use-schedule-actions";

/** `"Ray · own chat"`, or `"Ray → Crew"` when it posts elsewhere; ids stand in for gone names. */
function target(s: ScheduleDto, dir: Directory): string {
  const by = dir.botName(s.botId);
  if (s.conversationId === `bot:${s.botId}`) return `${by} · own chat`;
  return `${by} → ${conversationName(s.conversationId, dir)}`;
}

/**
 * One schedule (prototype `.sched-row`): face, name and target, task, when and next run,
 * last-result pill, Run now and the on switch. A click on the row opens `/schedules/<id>`;
 * the name is the keyboard path. Run now opens the chat; if a run is still going, the row
 * says so with a link to that chat.
 */
export function ScheduleRow({ schedule: s }: { schedule: ScheduleDto }) {
  const dir = useDirectory();
  const go = useAppNavigate();
  const { run, busy, pending, chat } = useRunNow(s);
  const onSwitch = useScheduleSwitch(s);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the name link is the keyboard path
    // biome-ignore lint/a11y/useKeyWithClickEvents: the name link is the keyboard path
    <div
      className={s.enabled ? "sched-row" : "sched-row off"}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button, a")) go(`/schedules/${s.id}`);
      }}
    >
      <Avatar src={dir.bots.get(s.botId)?.avatarUrl} name={dir.botName(s.botId)} size={32} />
      <div className="grow">
        <div className="s1">
          <Link className="s-name" to={`/schedules/${s.id}`}>
            <b>{s.name}</b>
          </Link>
          <span className="t2">{target(s, dir)}</span>
        </div>
        <div className="s2">{s.task}</div>
      </div>
      <div className="s-when">
        <div>
          <Repeat strokeWidth={1.75} aria-hidden />
          {s.when}
        </div>
        <div className="t2">
          {s.enabled && s.nextRunAt !== undefined
            ? `Next ${formatNextRun(s.nextRunAt, Date.now(), s.timeZone)}`
            : "Paused"}
        </div>
      </div>
      <div className="s-last">
        <ScheduleStatusPill schedule={s} />
        {busy && (
          <div className="s-busy">
            Still running · <Link to={chat}>Open chat</Link>
          </div>
        )}
      </div>
      <Button className="s-run" disabled={!s.enabled || pending} onClick={run}>
        <Play size={14} strokeWidth={1.75} />
        Run now
      </Button>
      <Switch
        label={`${s.name} on`}
        on={s.enabled}
        disabled={onSwitch.disabled}
        onChange={onSwitch.toggle}
      />
    </div>
  );
}
