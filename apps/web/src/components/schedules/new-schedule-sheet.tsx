import type { ScheduleDto } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { useIsPhone } from "../../app/use-is-phone";
import { useFormState } from "../settings/use-form-state";
import { BottomSheet } from "../ui/bottom-sheet";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { ScheduleForm } from "./schedule-form";
import {
  checkForm,
  formError,
  isFieldError,
  newScheduleForm,
  refusal,
  sendSchedule,
} from "./schedule-form-state";
import { useCreateSchedule } from "./use-schedules";

export interface NewScheduleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new schedule after the sheet closed (the app opens its page). */
  onCreated?: (schedule: ScheduleDto) => void;
}

/** Today on this device's calendar, `YYYY-MM-DD` (the first date a Once schedule offers). */
const today = () => new Date().toLocaleDateString("en-CA");

/** The form and buttons; mounted only while the sheet is open, so every opening starts blank. */
function NewScheduleForm({ onOpenChange, onCreated }: Omit<NewScheduleSheetProps, "open">) {
  const dir = useDirectory();
  const first = dir.bots.keys().next().value ?? "";
  const form = useFormState(newScheduleForm(first, today()));
  const create = useCreateSchedule();
  const v = form.value;
  const canCreate = v.name.trim() !== "" && v.task.trim() !== "" && v.botId !== "" && !form.saving;

  const save = () =>
    form.submit(async (f) => {
      const input = checkForm(f);
      if (isFieldError(input)) throw refusal(input.field, input.error);
      const s = await sendSchedule(() =>
        create.mutateAsync({
          ...input,
          botId: f.botId,
          conversationId: f.conversationId,
          ...(f.timeZone && { timeZone: f.timeZone }),
        }),
      );
      onOpenChange(false);
      onCreated?.(s);
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canCreate) void save();
      }}
    >
      <h3>New schedule</h3>
      <ScheduleForm value={v} set={form.set} errors={form.errors} mode="create" />
      {formError(form.errors) && (
        <div className="help err sched-form-err" role="alert">
          {formError(form.errors)}
        </div>
      )}
      <div className="acts">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!canCreate}>
          {form.saving ? "Creating…" : "Create schedule"}
        </Button>
      </div>
    </form>
  );
}

/** New-schedule sheet: drops from the toolbar on desktop, rises from the bottom on the phone. */
export function NewScheduleSheet(props: NewScheduleSheetProps) {
  const phone = useIsPhone();
  const form = <NewScheduleForm onOpenChange={props.onOpenChange} onCreated={props.onCreated} />;
  return phone ? (
    <BottomSheet open={props.open} onOpenChange={props.onOpenChange}>
      {form}
    </BottomSheet>
  ) : (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      {form}
    </Sheet>
  );
}
