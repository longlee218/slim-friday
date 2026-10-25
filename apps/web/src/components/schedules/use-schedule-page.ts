import type { ScheduleDto } from "@friday/contracts";
import { useState } from "react";
import { useFormState } from "../settings/use-form-state";
import { isFieldError, scheduleToForm } from "./schedule-form-state";
import { refusal, schedulePatch, sendSchedule } from "./schedule-save";
import { useScheduleSwitch } from "./use-schedule-actions";
import { useUpdateSchedule } from "./use-schedules";

/** Why a schedule can only be deleted. */
const GONE: Partial<Record<NonNullable<ScheduleDto["disabledReason"]>, string>> = {
  bot_gone: "Its bot is gone, so this schedule cannot run or change. You can delete it.",
  group_gone: "Its group is gone, so this schedule cannot run or change. You can delete it.",
};

/**
 * State of one schedule's page, shared by the desktop and phone layouts: the form and its save
 * (a refused field throws its message, an empty patch sends nothing), the on switch, the delete
 * sheet and `gone` (the read-only reason when the bot or group is gone).
 */
export function useSchedulePage(s: ScheduleDto) {
  const form = useFormState(scheduleToForm(s));
  const update = useUpdateSchedule();
  const onSwitch = useScheduleSwitch(s);
  const [deleting, setDeleting] = useState(false);
  const gone = s.disabledReason ? GONE[s.disabledReason] : undefined;

  const save = () =>
    form.submit(async (f) => {
      const patch = schedulePatch(f, s);
      if (isFieldError(patch)) throw refusal(patch.field, patch.error);
      if (Object.keys(patch).length === 0) return;
      await sendSchedule(() => update.mutateAsync({ id: s.id, ...patch }));
    });

  /** Save and Revert are off while clean, saving or read-only. */
  const canSave = form.dirty && !form.saving && !gone;
  return { form, save, canSave, onSwitch, deleting, setDeleting, gone };
}
