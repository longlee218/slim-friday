import type { ScheduleDto } from "@friday/contracts";
import { ChevronRight, MessageCircle, Play } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useDirectory } from "../../api/directory";
import { StaleNotice, Switch } from "../settings/form-parts";
import { useFormState } from "../settings/use-form-state";
import { Toolbar } from "../shell/toolbar";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { DeleteScheduleSheet } from "./delete-schedule-sheet";
import { formatNextRun } from "./format-next-run";
import { ScheduleForm } from "./schedule-form";
import {
  checkForm,
  formError,
  isFieldError,
  refusal,
  scheduleToForm,
  sendSchedule,
} from "./schedule-form-state";
import { ScheduleRuns } from "./schedule-runs";
import { conversationName } from "./schedule-target";
import { useRunNow, useScheduleSwitch } from "./use-schedule-actions";
import { useUpdateSchedule } from "./use-schedules";

/** Why a schedule can only be deleted. */
const GONE: Partial<Record<NonNullable<ScheduleDto["disabledReason"]>, string>> = {
  bot_gone: "Its bot is gone, so this schedule cannot run or change. You can delete it.",
  group_gone: "Its group is gone, so this schedule cannot run or change. You can delete it.",
};

/** Toolbar: "Schedules > name" crumb, Run now ("Still running" when one is going), Open chat. */
function PageToolbar({ schedule: s }: { schedule: ScheduleDto }) {
  const go = useAppNavigate();
  const { run, busy, pending, chat } = useRunNow(s);
  return (
    <Toolbar
      title={
        <span className="crumb">
          <button type="button" className="linkbtn" onClick={() => go("/schedules")}>
            Schedules
          </button>
          <ChevronRight />
          <span>{s.name}</span>
        </span>
      }
      actions={
        <>
          {busy && (
            <span className="s-busy">
              Still running · <Link to={chat}>Open chat</Link>
            </span>
          )}
          <Button disabled={!s.enabled || pending} onClick={run}>
            <Play size={14} strokeWidth={1.75} />
            Run now
          </Button>
          <Link className="btn" to={chat}>
            <MessageCircle size={14} strokeWidth={1.75} />
            Open chat
          </Link>
        </>
      }
    />
  );
}

/**
 * One schedule (prototype `scheduleView`): head with face, name, `when · posts to … · next …`
 * and the on switch; the form; Recent runs; the save bar (Delete, Revert, Save). A refused
 * field shows its message there and nothing is saved; the server's refusal shows under the
 * form. A schedule whose bot or group is gone is read-only except Delete.
 */
export function SchedulePage({ schedule: s }: { schedule: ScheduleDto }) {
  const dir = useDirectory();
  const form = useFormState(scheduleToForm(s));
  const update = useUpdateSchedule();
  const onSwitch = useScheduleSwitch(s);
  const [deleting, setDeleting] = useState(false);
  const gone = s.disabledReason ? GONE[s.disabledReason] : undefined;
  const next =
    s.enabled && s.nextRunAt !== undefined
      ? `next ${formatNextRun(s.nextRunAt, Date.now(), s.timeZone)}`
      : "paused";

  const save = () =>
    form.submit(async (f) => {
      const input = checkForm(f);
      if (isFieldError(input)) throw refusal(input.field, input.error);
      await sendSchedule(() => update.mutateAsync({ id: s.id, ...input }));
    });

  return (
    <section className="pane">
      <PageToolbar schedule={s} />
      <div className="content">
        <div className="page sched-page">
          <div className="page-head">
            <Avatar src={dir.bots.get(s.botId)?.avatarUrl} name={dir.botName(s.botId)} size={48} />
            <div className="grow">
              <h2>{s.name}</h2>
              <div className="r">
                {s.when} · posts to {conversationName(s.conversationId, dir)} · {next}
              </div>
            </div>
            <Switch
              label="On"
              on={s.enabled}
              disabled={onSwitch.disabled}
              onChange={onSwitch.toggle}
            />
          </div>
          {gone && (
            <div className="foot-note sched-gone" role="status">
              {gone}
            </div>
          )}
          {form.stale && <StaleNotice what="schedule" />}
          <ScheduleForm
            value={form.value}
            set={form.set}
            errors={form.errors}
            mode="edit"
            readOnly={gone !== undefined}
          />
          {formError(form.errors) && (
            <div className="help err sched-form-err" role="alert">
              {formError(form.errors)}
            </div>
          )}
          <h3 className="sched-runs-title">Recent runs</h3>
          <ScheduleRuns schedule={s} />
          <div className="savebar">
            <Button variant="danger" className="sched-delete" onClick={() => setDeleting(true)}>
              Delete
            </Button>
            <Button disabled={!form.dirty || form.saving || !!gone} onClick={form.revert}>
              Revert
            </Button>
            <Button
              variant="primary"
              disabled={!form.dirty || form.saving || !!gone}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
      <DeleteScheduleSheet schedule={s} open={deleting} onOpenChange={setDeleting} />
    </section>
  );
}
