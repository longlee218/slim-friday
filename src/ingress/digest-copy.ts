import type { OwnerLanguage } from "./user-copy";

/* Owner text of the check-in digest (vi / en): rendered by app code from the digest facts, no model. The facts are already
   redacted and clipped (digest-facts.ts); this file only words them. Never carries result file content. */

/** One open item of the goal. */
export interface DigestItem {
  key: string;
  role: string;
  status: string;
  /** True for a held item (blocked after a failure): it waits for the lead's decision. */
  held: boolean;
  percent?: number;
  note?: string;
  /** Seconds since the item's last activity or status change (shown, never hashed). */
  ageSeconds: number;
}

/** Facts of one digest. */
export interface DigestFacts {
  objective: string;
  items: DigestItem[];
  /** Items that already ended, and all items of the goal. */
  done: number;
  total: number;
  spentUsd: number;
  budgetUsd: number;
}

/** "45s" / "59m" / "2h" for a count of seconds (rounded down, so 3570 s never reads "60m"). */
function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/** The digest message: goal line, one bullet per open item, held items flagged, spend against the goal budget. */
export function renderDigest(f: DigestFacts, language: OwnerLanguage): string {
  const say = (vi: string, en: string) => (language === "vi" ? vi : en);
  const lines = f.items.map((i) => {
    const pct = i.percent === undefined ? "" : ` ${i.percent}%`;
    const note = i.note ? `, ${i.note}` : "";
    const held = i.held ? say(" - đang chờ quyết định", " - waiting for decision") : "";
    return `- ${i.key} (${i.role}): ${i.status}${pct}${note}, ${ago(i.ageSeconds)}${held}`;
  });
  return [
    say(`Cập nhật: ${f.objective}`, `Check-in: ${f.objective}`),
    say(`Xong ${f.done}/${f.total} việc.`, `${f.done}/${f.total} items done.`),
    ...lines,
    say(
      `Chi phí: $${f.spentUsd.toFixed(2)} / $${f.budgetUsd}`,
      `Spend: $${f.spentUsd.toFixed(2)} / $${f.budgetUsd}`,
    ),
  ].join("\n");
}
