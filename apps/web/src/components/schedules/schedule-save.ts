import type { RepeatRuleDto, ScheduleDto } from "@friday/contracts";
import { isBadRequest, saveFailure } from "../settings/field-error";
import {
  checkForm,
  type FieldError,
  isFieldError,
  type ScheduleFormValue,
} from "./schedule-form-state";

/** What `schedules.update` takes besides the id. */
export type SchedulePatch = Partial<{
  name: string;
  task: string;
  rule: RepeatRuleDto;
  notify: ScheduleDto["notify"];
}>;

/** Same rule, whatever the key order. */
const sameRule = (a: RepeatRuleDto, b: RepeatRuleDto): boolean =>
  JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

/**
 * Only the fields that differ from the saved schedule `s`, or the first refused field. The rule
 * goes only when it changed: the board recomputes the next run for any rule it gets (an
 * interval would restart, a finished Once would be refused as past).
 */
export function schedulePatch(f: ScheduleFormValue, s: ScheduleDto): SchedulePatch | FieldError {
  const input = checkForm(f);
  if (isFieldError(input)) return input;
  return {
    ...(input.name !== s.name && { name: input.name }),
    ...(input.task !== s.task && { task: input.task }),
    ...(!sameRule(input.rule, s.rule) && { rule: input.rule }),
    ...(input.notify !== s.notify && { notify: input.notify }),
  };
}

/** A `BAD_REQUEST` on `field`: `useFormState.submit` shows it by that field (`form`: under the form). */
export const refusal = (field: string, message: string): Error =>
  Object.assign(new Error(message), { code: "BAD_REQUEST", data: { field } });

/** Runs `send`; the server's `BAD_REQUEST` (it names no field) becomes one on `form`. */
export async function sendSchedule<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    const { field, message } = saveFailure(e);
    throw isBadRequest(e) && !field ? refusal("form", message) : e;
  }
}

/** The message shown under the form (the server's refusal), from `useFormState().errors`. */
export const formError = (errors: object): string | undefined => (errors as { form?: string }).form;

/** Id of the form error line; the Save (or Create) button points at it with aria-describedby. */
export const FORM_ERROR_ID = "sched-form-err";
