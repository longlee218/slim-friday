import type { ScheduleDto } from "@friday/contracts";
import { Play } from "lucide-react";
import { Link } from "react-router";
import { useDirectory } from "../../api/directory";
import { StaleNotice, Switch } from "../settings/form-parts";
import { SettingsPage } from "../settings/settings-page";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { DeleteScheduleSheet } from "./delete-schedule-sheet";
import { FormErrorLine, ScheduleForm } from "./schedule-form";
import { ScheduleRuns } from "./schedule-runs";
import { FORM_ERROR_ID, formError } from "./schedule-save";
import { conversationName } from "./schedule-target";
import { useRunNow } from "./use-schedule-actions";
import { useSchedulePage } from "./use-schedule-page";

/**
 * `/schedules/:id` on the phone (prototype phone `sched`): a pushed page with Save in the bar;
 * head with face, name, `when → target` and the on switch; Run now; the form; Recent runs;
 * Delete schedule (a bottom sheet confirms). Same rules as the desktop page.
 */
export function PhoneSchedulePage({ schedule: s }: { schedule: ScheduleDto }) {
  const dir = useDirectory();
  const { form, save, canSave, onSwitch, deleting, setDeleting, gone } = useSchedulePage(s);
  const { run, busy, pending, chat } = useRunNow(s);
  const saveButton = (
    <button
      type="button"
      className="nb"
      disabled={!canSave}
      aria-describedby={formError(form.errors) ? FORM_ERROR_ID : undefined}
      onClick={() => void save()}
    >
      {form.saving ? "Saving…" : "Save"}
    </button>
  );
  return (
    <SettingsPage title={s.name} right={saveButton}>
      <div className="ph-sched-head">
        <Avatar src={dir.bots.get(s.botId)?.avatarUrl} name={dir.botName(s.botId)} size={40} />
        <div className="grow">
          <b>{s.name}</b>
          <div className="t2">
            {s.when} → {conversationName(s.conversationId, dir)}
          </div>
        </div>
        <Switch label="On" on={s.enabled} disabled={onSwitch.disabled} onChange={onSwitch.toggle} />
      </div>
      {gone && (
        <div className="foot-note sched-gone" role="status">
          {gone}
        </div>
      )}
      <Button variant="primary" className="ph-wide" disabled={!s.enabled || pending} onClick={run}>
        <Play size={14} strokeWidth={1.75} />
        Run now
      </Button>
      {busy && (
        <div className="s-busy ph-busy">
          Still running · <Link to={chat}>Open chat</Link>
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
      <FormErrorLine errors={form.errors} />
      <h3 className="sched-runs-title">Recent runs</h3>
      <ScheduleRuns schedule={s} />
      <Button variant="danger" className="ph-wide ph-delete" onClick={() => setDeleting(true)}>
        Delete schedule
      </Button>
      <DeleteScheduleSheet schedule={s} open={deleting} onOpenChange={setDeleting} />
    </SettingsPage>
  );
}
