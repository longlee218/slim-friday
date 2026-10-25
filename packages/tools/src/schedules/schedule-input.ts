import type { RepeatRule } from "@friday/core";
import { z } from "zod";

/** Weekday names in the order of `RepeatRule.weekday` (0 = Sunday). */
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * The input fields shared by `ScheduleCreate` and `ScheduleUpdate` (all optional here; create makes some required).
 * Formats and ranges are checked by the board, so its refusal reaches the model as a readable error.
 */
export const RULE_FIELDS = {
  repeat: z
    .enum(["daily", "weekdays", "weekly", "interval", "once"])
    .describe("How it repeats: daily, weekdays (Mon-Fri), weekly, interval or once."),
  at: z.string().optional().describe('Time of day, "HH:MM" 24 h (daily, weekdays, weekly, once).'),
  weekday: z.enum(WEEKDAYS).optional().describe("Day of the week (weekly)."),
  every: z.number().int().optional().describe("Gap between runs (interval; at least 15 minutes)."),
  unit: z.enum(["minutes", "hours"]).optional().describe("Unit of `every` (interval)."),
  date: z.string().optional().describe('Day, "YYYY-MM-DD" (once).'),
};

/** The other changeable fields of a schedule. */
export const TEXT_FIELDS = {
  name: z.string().describe("Short label, 1 to 80 characters."),
  task: z
    .string()
    .describe(
      "What to do at each run, 1 to 4000 characters; it must stand alone without this chat.",
    ),
  notify: z
    .enum(["always", "problems"])
    .optional()
    .describe(
      '"always" (default) posts every result; "problems" stays silent unless there is something to report.',
    ),
};

/** The rule fields as the model sent them. */
export interface RuleInput {
  repeat: (typeof RULE_FIELDS.repeat.options)[number];
  at?: string;
  weekday?: (typeof WEEKDAYS)[number];
  every?: number;
  unit?: "minutes" | "hours";
  date?: string;
}

/** The repeat rule of the input, or a readable reason a field it needs is missing. */
export function toRule(i: RuleInput): RepeatRule | string {
  const need = (field: string) => `repeat "${i.repeat}" needs ${field}.`;
  switch (i.repeat) {
    case "daily":
    case "weekdays":
      return i.at === undefined ? need("at") : { kind: i.repeat, at: i.at };
    case "weekly":
      if (i.at === undefined) return need("at");
      if (i.weekday === undefined) return need("weekday (mon to sun)");
      return { kind: "weekly", at: i.at, weekday: WEEKDAYS.indexOf(i.weekday) };
    case "interval":
      if (i.every === undefined) return need("every");
      if (i.unit === undefined) return need("unit (minutes or hours)");
      return { kind: "interval", every: i.every, unit: i.unit };
    case "once":
      if (i.date === undefined) return need("date");
      if (i.at === undefined) return need("at");
      return { kind: "once", date: i.date, at: i.at };
  }
}
