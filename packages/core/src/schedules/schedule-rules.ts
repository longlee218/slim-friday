import type { RepeatRule } from "./schedule";

/** Shortest allowed gap of an `interval` rule, in minutes. */
export const MIN_INTERVAL_MINUTES = 15;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Why a rule is invalid, or undefined when it is fine. */
export function ruleError(rule: RepeatRule): string | undefined {
  if (rule.kind === "interval") {
    if (!Number.isInteger(rule.every)) return "interval must be a whole number";
    if (rule.unit === "minutes") {
      return rule.every >= MIN_INTERVAL_MINUTES
        ? undefined
        : `interval must be at least ${MIN_INTERVAL_MINUTES} minutes`;
    }
    return rule.every >= 1 && rule.every <= 24 ? undefined : "interval hours must be 1 to 24";
  }
  if (!TIME_RE.test(rule.at)) return `time must be HH:MM (24 h), got "${rule.at}"`;
  if (
    rule.kind === "weekly" &&
    !(Number.isInteger(rule.weekday) && rule.weekday >= 0 && rule.weekday <= 6)
  ) {
    return "weekday must be 0 (Sunday) to 6 (Saturday)";
  }
  if (rule.kind === "once" && !DATE_RE.test(rule.date)) {
    return `date must be YYYY-MM-DD, got "${rule.date}"`;
  }
  return undefined;
}

/** Why a time zone is unknown, or undefined when Intl accepts it. */
export function timeZoneError(tz: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return undefined;
  } catch {
    return `unknown time zone "${tz}"`;
  }
}

/** A short human text of a rule, ending with its zone, e.g. `Every Monday 08:00 (Asia/Saigon)`. */
export function describeRule(rule: RepeatRule, timeZone: string): string {
  let text: string;
  switch (rule.kind) {
    case "daily":
      text = `Every day ${rule.at}`;
      break;
    case "weekdays":
      text = `Weekdays ${rule.at}`;
      break;
    case "weekly":
      text = `Every ${WEEKDAY_NAMES[rule.weekday]} ${rule.at}`;
      break;
    case "interval":
      text = `Every ${rule.every} ${rule.unit === "minutes" ? "min" : "h"}`;
      break;
    case "once":
      text = `Once ${rule.date} ${rule.at}`;
      break;
  }
  return `${text} (${timeZone})`;
}

/** An instant as local wall time in `timeZone`, e.g. `Sat 25 Oct 07:30`. */
export function formatLocal(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`;
}
