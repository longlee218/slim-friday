import type { SpendDto, WakeDto } from "@friday/contracts";

const DAY_MS = 86_400_000;

/** One chart column: the day, spend per bot and the day's total (USD). */
export interface SpendDay {
  day: string;
  byBot: Record<string, number>;
  total: number;
}

/**
 * The server books spend on UTC days (`dayOf` in core: `toISOString().slice(0, 10)`), so the
 * page uses UTC days too, not the owner's local days; otherwise "today" would drift from the
 * rows the engine writes for a few hours a day.
 */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Epoch ms of the start of a `YYYY-MM-DD` UTC day. */
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** `from`..`to` (inclusive) of the last `days` days ending at `to`; never above the API's 31. */
export function dayRange(to: string, days: 7 | 30): { from: string; to: string } {
  return { from: utcDay(dayMs(to) - (days - 1) * DAY_MS), to };
}

/** One entry per day ending at `to`, oldest first; days without rows are zero. */
export function spendDays(rows: SpendDto[], to: string, days: 7 | 30): SpendDay[] {
  const out: SpendDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push({ day: utcDay(dayMs(to) - i * DAY_MS), byBot: {}, total: 0 });
  }
  const byDay = new Map(out.map((d) => [d.day, d]));
  for (const r of rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.byBot[r.botId] = (d.byBot[r.botId] ?? 0) + r.usd;
    d.total += r.usd;
  }
  return out;
}

/** Meter colour: tint under 50% of the limit, amber from 50%, red at 100%. */
export function limitTone(ratio: number): "tint" | "amber" | "red" {
  if (ratio >= 1) return "red";
  return ratio >= 0.5 ? "amber" : "tint";
}

/** Filter bucket of a wake: queued and running are live; blocked, interrupted, dropped failed. */
export function wakeBucket(s: WakeDto["status"]): "running" | "failed" | "other" {
  if (s === "running" || s === "queued") return "running";
  if (s === "blocked" || s === "interrupted" || s === "dropped") return "failed";
  return "other";
}

/** Pill tone per wake status, shared by the desktop table and the phone list. */
export function wakeTone(s: WakeDto["status"]): "blue" | "green" | "red" | "gray" {
  if (s === "expired") return "gray";
  const b = wakeBucket(s);
  return b === "running" ? "blue" : b === "failed" ? "red" : "green";
}
