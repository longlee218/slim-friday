const DAY = 86_400_000;

/** Sidebar time: HH:MM today, weekday this week, else short date. */
export function timeLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (ts >= startOfToday - 6 * DAY) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}
