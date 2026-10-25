import type { NextRunAt, RepeatRule } from "@friday/core";
import { Cron } from "croner";

const MINUTE_MS = 60_000;

/** The cron pattern of a calendar rule ("m h * * dow"); `at` is already checked as HH:MM. */
function cronPattern(rule: Exclude<RepeatRule, { kind: "interval" | "once" }>): string {
  const [h, m] = rule.at.split(":").map(Number);
  const dow = rule.kind === "daily" ? "*" : rule.kind === "weekdays" ? "1-5" : String(rule.weekday);
  return `${m} ${h} * * ${dow}`;
}

/** Epoch ms of the local wall time `date` `at` in `timeZone` (a skipped time moves forward). */
function localInstant(date: string, at: string, timeZone: string): number | undefined {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = at.split(":").map(Number);
  // A one-shot cron on that exact day, searched from the day before, gives the instant with DST rules.
  const day = new Cron(`${mi} ${h} ${d} ${mo} *`, { timezone: timeZone, maxRuns: 1 });
  const from = Date.UTC(y, mo - 1, d) - 2 * 86_400_000;
  const hit = day.nextRun(new Date(from));
  return hit && hit.getTime() < from + 5 * 86_400_000 ? hit.getTime() : undefined;
}

/** `NextRunAt` on croner: cron and time-zone math for calendar rules, plain arithmetic for the rest. */
export const nextRunAtCroner: NextRunAt = (rule, timeZone, after, anchor) => {
  if (rule.kind === "interval") {
    const gap = rule.every * (rule.unit === "hours" ? 60 : 1) * MINUTE_MS;
    if (anchor === undefined) return after + gap;
    // Next anchor + k * gap strictly after `after`; never earlier than one gap past the anchor.
    const k = Math.max(1, Math.floor((after - anchor) / gap) + 1);
    return anchor + k * gap;
  }
  if (rule.kind === "once") {
    const at = localInstant(rule.date, rule.at, timeZone);
    return at !== undefined && at > after ? at : undefined;
  }
  return new Cron(cronPattern(rule), { timezone: timeZone }).nextRun(new Date(after))?.getTime();
};
