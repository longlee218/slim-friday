import type { ScheduleDto } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { useIsPhone } from "../../app/use-is-phone";
import { useFormState } from "../settings/use-form-state";
import { BottomSheet } from "../ui/bottom-sheet";
import { Sheet } from "../ui/sheet";
import { SheetForm } from "../ui/sheet-bar";
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

  const submit = () => {
    if (canCreate) void save();
  };
  const describedBy = formError(form.errors) ? FORM_ERROR_ID : undefined;
  return (
    <SheetForm
      title="New schedule"
      onCancel={() => onOpenChange(false)}
      onSubmit={submit}
      action={
        <button
          type="submit"
          className="nb strong"
          disabled={!canCreate}
          aria-label="Create schedule"
          aria-describedby={describedBy}
        >
          {form.saving ? "Creating…" : "Create"}
        </button>
      }
    >
      <ScheduleForm value={v} set={form.set} errors={form.errors} mode="create" />
      <FormErrorLine errors={form.errors} />
    </SheetForm>
  );
}

/** New-schedule sheet: a centred glass sheet on desktop, rises from the bottom on the phone. */
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
