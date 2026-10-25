import type { RepeatRuleDto, ScheduleDto } from "@friday/contracts";
import { isBadRequest, saveFailure } from "../settings/field-error";

/** The five Repeat choices. */
export type RepeatKind = RepeatRuleDto["kind"];
export const REPEAT_KINDS: readonly RepeatKind[] = [
  "daily",
  "weekdays",
  "weekly",
  "interval",
  "once",
];
export const REPEAT_NAMES: Record<RepeatKind, string> = {
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Weekly",
  interval: "Interval",
  once: "Once",
};

/** The form's rule fields; every kind keeps its own, so switching Repeat loses nothing. */
export interface RuleFields {
  repeat: RepeatKind;
  /** `HH:MM`, 24 h (all kinds but interval). */
  at: string;
  /** 0 Sunday to 6 Saturday (weekly). */
  weekday: number;
  /** Interval length as typed (interval). */
  every: string;
  unit: "minutes" | "hours";
  /** `YYYY-MM-DD` (once). */
  date: string;
}

/** Everything the schedule form edits. */
export interface ScheduleFormValue extends RuleFields {
  name: string;
  botId: string;
  task: string;
  /** IANA zone; empty on a new schedule means the owner zone (the server fills it in). */
  timeZone: string;
  conversationId: string;
  notify: ScheduleDto["notify"];
}

/** A refused field and the reason, shown under that field. */
export interface FieldError {
  field: keyof ScheduleFormValue;
  error: string;
}

/** True when a check returned a refusal. */
export const isFieldError = (x: object): x is FieldError => "error" in x;

// Same limits and messages as the board (core `schedule-rules.ts`, `schedule-board-checks.ts`).
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MIN_INTERVAL_MINUTES = 15;
const NAME_MAX = 80;
const TASK_MAX = 4000;

const RULE_DEFAULTS: RuleFields = {
  repeat: "daily",
  at: "09:00",
  weekday: 1,
  every: "30",
  unit: "minutes",
  date: "",
};

/** The form fields of a rule; the other kinds' fields take their defaults. */
export function ruleToForm(rule: RepeatRuleDto): RuleFields {
  const f = { ...RULE_DEFAULTS, repeat: rule.kind };
  if (rule.kind === "interval") return { ...f, every: String(rule.every), unit: rule.unit };
  if (rule.kind === "weekly") return { ...f, at: rule.at, weekday: rule.weekday };
  if (rule.kind === "once") return { ...f, at: rule.at, date: rule.date };
  return { ...f, at: rule.at };
}

/** The rule the fields describe, or the first refused field with the board's message. */
export function formToRule(f: RuleFields): RepeatRuleDto | FieldError {
  if (f.repeat === "interval") {
    const text = f.every.trim();
    const every = Number(text);
    if (!/^\d+$/.test(text)) return { field: "every", error: "interval must be a whole number" };
    if (f.unit === "hours") {
      return every >= 1 && every <= 24
        ? { kind: "interval", unit: "hours", every }
        : { field: "every", error: "interval hours must be 1 to 24" };
    }
    return every >= MIN_INTERVAL_MINUTES
      ? { kind: "interval", unit: "minutes", every }
      : { field: "every", error: `interval must be at least ${MIN_INTERVAL_MINUTES} minutes` };
  }
  if (!TIME.test(f.at)) return { field: "at", error: `time must be HH:MM (24 h), got "${f.at}"` };
  if (f.repeat === "weekly") return { kind: "weekly", at: f.at, weekday: f.weekday };
  if (f.repeat === "once") {
    return DATE.test(f.date)
      ? { kind: "once", date: f.date, at: f.at }
      : { field: "date", error: `date must be YYYY-MM-DD, got "${f.date}"` };
  }
  return { kind: f.repeat, at: f.at };
}

/** The fields an edit sends (trimmed), or the first refused field. */
export function checkForm(
  f: ScheduleFormValue,
): { name: string; task: string; rule: RepeatRuleDto; notify: ScheduleDto["notify"] } | FieldError {
  const name = f.name.trim();
  const task = f.task.trim();
  if (!name || name.length > NAME_MAX) {
    return { field: "name", error: `name must be 1 to ${NAME_MAX} characters` };
  }
  if (!task || task.length > TASK_MAX) {
    return { field: "task", error: `task must be 1 to ${TASK_MAX} characters` };
  }
  const rule = formToRule(f);
  return isFieldError(rule) ? rule : { name, task, rule, notify: f.notify };
}

/** A saved schedule as form fields. */
export const scheduleToForm = (s: ScheduleDto): ScheduleFormValue => ({
  ...ruleToForm(s.rule),
  name: s.name,
  botId: s.botId,
  task: s.task,
  timeZone: s.timeZone,
  conversationId: s.conversationId,
  notify: s.notify,
});

/** A blank form for `botId` posting to its own chat; `today` seeds the Once date. */
export const newScheduleForm = (botId: string, today: string): ScheduleFormValue => ({
  ...RULE_DEFAULTS,
  date: today,
  name: "",
  botId,
  task: "",
  timeZone: "",
  conversationId: `bot:${botId}`,
  notify: "always",
});

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
