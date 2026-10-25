/** `{ day: "2026-10-27", time: "07:30" }` of `at` on the wall clock of `timeZone`. */
function wallClock(at: number, timeZone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const p = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? "";
  return { day: `${p("year")}-${p("month")}-${p("day")}`, time: `${p("hour")}:${p("minute")}` };
}

/** Whole calendar days from day `a` to day `b` (both `YYYY-MM-DD`). */
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00Z`) - Date.parse(`${a}T00:00Z`)) / 86_400_000);

/**
 * When a schedule fires next, on its own time zone's calendar: `"Today 14:00"`,
 * `"Tomorrow 07:30"`, a weekday (`"Thu 08:00"`) within 7 days, else `"8 Nov 00:00"`.
 */
export function formatNextRun(at: number, now: number, timeZone: string): string {
  const next = wallClock(at, timeZone);
  const days = daysBetween(wallClock(now, timeZone).day, next.day);
  if (days <= 0) return `Today ${next.time}`;
  if (days === 1) return `Tomorrow ${next.time}`;
  const date = new Date(`${next.day}T12:00Z`);
  if (days < 7) {
    return `${date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${next.time}`;
  }
  const month = date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${date.getUTCDate()} ${month} ${next.time}`;
}

/**
 * The line under a schedule's `when`: `"Next Tomorrow 07:30"` while on, `"Paused"` when the
 * owner turned it off, nothing when the engine did (done, bot or group gone: its pill says so).
 */
export function nextRunNote(
  s: { enabled: boolean; nextRunAt?: number; timeZone: string; disabledReason?: string },
  now: number,
): string | undefined {
  if (s.enabled) {
    return s.nextRunAt === undefined
      ? undefined
      : `Next ${formatNextRun(s.nextRunAt, now, s.timeZone)}`;
  }
  return s.disabledReason ? undefined : "Paused";
}
