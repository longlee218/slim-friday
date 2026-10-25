/**
 * The current-time text that ends every turn (R§7, "owner" for "user"). Models have no clock; the turn states the
 * real present moment so it is never guessed. It stays out of the system prompt so the cached prefix does not change
 * every call. With a usable IANA zone the owner's wall-clock time leads and the UTC instant follows; an unusable
 * zone falls back to UTC only.
 */
export function currentTimeText(now: number, timeZone: string): string {
  const date = new Date(now);
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const local = localDateTime(date, timeZone);
  const anchor = local
    ? `Current date and time for the owner: ${local} (${timeZone}). That is ${iso} (UTC).`
    : `Current date and time: ${weekdayIn(date, "UTC")}, ${iso} (UTC).`;
  return [
    anchor,
    "Treat this as the present moment for everything you say and do.",
    local
      ? "Use the owner's time zone for times you mention unless they ask otherwise, judge what is past, upcoming, or overdue from it, and write absolute dates rather than relative ones."
      : "Use it to judge what is past, upcoming, or overdue, convert it to the owner's time zone when one is known, and write absolute dates rather than relative ones.",
    "Never infer today's date from your training data or from timestamps quoted in the conversation.",
  ].join(" ");
}

/** The weekday name of `date` in `timeZone`. */
function weekdayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(date);
}

/** "Saturday, 2026-10-17 22:15 (UTC+13:00)", or undefined for an unusable zone. */
function localDateTime(date: Date, timeZone: string): string | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    }).formatToParts(date);
  } catch {
    return undefined;
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  // "GMT+13:00" / "GMT" from longOffset, shown as UTC to match the instant beside it.
  const offset = part("timeZoneName").replace(/^GMT/, "UTC") || "UTC";
  return `${part("weekday")}, ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} (${offset === "UTC" ? "UTC+00:00" : offset})`;
}
