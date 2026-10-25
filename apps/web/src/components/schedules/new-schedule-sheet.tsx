import type { ScheduleDto } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { useIsPhone } from "../../app/use-is-phone";
import { useFormState } from "../settings/use-form-state";
import { BottomSheet } from "../ui/bottom-sheet";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { FormErrorLine, ScheduleForm } from "./schedule-form";
import { checkForm, isFieldError, localToday, newScheduleForm } from "./schedule-form-state";
import { FORM_ERROR_ID, formError, refusal, sendSchedule } from "./schedule-save";
import { useCreateSchedule } from "./use-schedules";

/** `/schedules?new=1` opens this sheet (New schedule buttons, the palette). */
export const NEW_SCHEDULE = "/schedules?new=1";

export interface NewScheduleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new schedule after the sheet closed (the app opens its page). */
  onCreated?: (schedule: ScheduleDto) => void;
}

/** The form and buttons; mounted only while the sheet is open, so every opening starts blank. */
function NewScheduleForm({ onOpenChange, onCreated }: Omit<NewScheduleSheetProps, "open">) {
  const dir = useDirectory();
  const first = dir.bots.keys().next().value ?? "";
  const form = useFormState(newScheduleForm(first, localToday()));
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
      <FormErrorLine errors={form.errors} />
      <div className="acts">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!canCreate}
          aria-describedby={formError(form.errors) ? FORM_ERROR_ID : undefined}
        >
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
