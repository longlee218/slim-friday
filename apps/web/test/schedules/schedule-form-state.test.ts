import type { RepeatRuleDto } from "@friday/contracts";
import { afterEach, expect, test, vi } from "vitest";
import {
  checkForm,
  formToRule,
  newScheduleForm,
  ruleToForm,
  timeZones,
} from "../../src/components/schedules/schedule-form-state";

const RULES: RepeatRuleDto[] = [
  { kind: "daily", at: "07:30" },
  { kind: "weekdays", at: "08:00" },
  { kind: "weekly", at: "09:15", weekday: 1 },
  { kind: "interval", every: 30, unit: "minutes" },
  { kind: "interval", every: 2, unit: "hours" },
  { kind: "once", date: "2026-11-02", at: "18:00" },
];

test.each(RULES)("form and rule round-trip: %o", (rule) => {
  const f = ruleToForm(rule);
  expect(formToRule(f)).toEqual(rule);
  expect(ruleToForm(formToRule(f) as RepeatRuleDto)).toEqual(f);
});

test("At 25:00 is refused on the at field with the board's message", () => {
  const r = formToRule({ ...ruleToForm({ kind: "daily", at: "07:30" }), at: "25:00" });
  expect(r).toEqual({ field: "at", error: 'time must be HH:MM (24 h), got "25:00"' });
});

test("an interval of 10 minutes is refused: at least 15 minutes", () => {
  const f = ruleToForm({ kind: "interval", every: 30, unit: "minutes" });
  expect(formToRule({ ...f, every: "10" })).toEqual({
    field: "every",
    error: "interval must be at least 15 minutes",
  });
});

test("other bad rule fields name their field", () => {
  const hours = ruleToForm({ kind: "interval", every: 2, unit: "hours" });
  expect(formToRule({ ...hours, every: "25" })).toMatchObject({ field: "every" });
  expect(formToRule({ ...hours, every: "1.5" })).toMatchObject({ field: "every" });
  const once = ruleToForm({ kind: "once", date: "2026-11-02", at: "18:00" });
  expect(formToRule({ ...once, date: "" })).toMatchObject({ field: "date" });
});

test("checkForm needs a name and a task, then returns the update fields", () => {
  const f = { ...newScheduleForm("ray", "2026-10-26"), name: " News ", task: "Read the news." };
  expect(checkForm({ ...f, name: " " })).toMatchObject({ field: "name" });
  expect(checkForm({ ...f, task: "" })).toMatchObject({ field: "task" });
  expect(checkForm(f)).toEqual({
    name: "News",
    task: "Read the news.",
    rule: { kind: "daily", at: "09:00" },
    notify: "always",
  });
});

afterEach(() => vi.unstubAllGlobals());

test("time zones include UTC, with a short built-in list when Intl cannot list them", () => {
  expect(timeZones()).toContain("UTC");
  expect(timeZones()).toContain("Asia/Ho_Chi_Minh");
  vi.stubGlobal("Intl", { ...Intl, supportedValuesOf: undefined });
  expect(timeZones()).toContain("UTC");
  expect(timeZones()).toContain("Asia/Ho_Chi_Minh");
});
