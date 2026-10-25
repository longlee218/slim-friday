import type { ScheduleDto } from "@friday/contracts";
import { Play, Repeat } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { type Directory, useDirectory } from "../../api/directory";
import { Switch } from "../settings/form-parts";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { formatNextRun } from "./format-next-run";
import { ScheduleStatusPill } from "./schedule-status-pill";
import { useRunScheduleNow, useSetScheduleEnabled } from "./use-schedules";

/** True for the API's "a run of this schedule is still going" error. */
const isConflict = (e: unknown): boolean => (e as { code?: string } | null)?.code === "CONFLICT";

/** `"Ray · own chat"`, or `"Ray → Crew"` when it posts elsewhere; ids stand in for gone names. */
function target(s: ScheduleDto, dir: Directory): string {
  const by = dir.botName(s.botId);
  if (s.conversationId === `bot:${s.botId}`) return `${by} · own chat`;
  const [kind, id = ""] = s.conversationId.split(":");
  const name = kind === "group" ? dir.groups.get(id)?.name : dir.bots.get(id)?.name;
  return `${by} → ${name ?? id}`;
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
  const runNow = useRunScheduleNow();
  const setEnabled = useSetScheduleEnabled();
  const [busy, setBusy] = useState(false);
  const chat = `/c/${s.conversationId}`;
  const gone = s.disabledReason === "bot_gone" || s.disabledReason === "group_gone";

  const run = () => {
    setBusy(false);
    runNow.mutate(
      { id: s.id },
      {
        onSuccess: () => go(chat),
        onError: (e) => (isConflict(e) ? setBusy(true) : toast("Could not run. Try again.")),
      },
    );
  };
  const toggle = (on: boolean) =>
    setEnabled.mutate(
      { id: s.id, enabled: on },
      { onError: () => toast("Could not save. Try again.") },
    );

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
      <Button className="s-run" disabled={!s.enabled || runNow.isPending} onClick={run}>
        <Play size={14} strokeWidth={1.75} />
        Run now
      </Button>
      <Switch
        label={`${s.name} on`}
        on={s.enabled}
        disabled={gone || setEnabled.isPending}
        onChange={toggle}
      />
    </div>
  );
}
