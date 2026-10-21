import type { OwnerLanguage } from "../i18n/languages";
import { t } from "../i18n/translate";

/* Owner text of the check-in digest (every language of the list): rendered by app code from the digest facts, no model. The facts are already
   redacted and clipped (digest-facts.ts); this file only words them. Never carries result file content. */

/** One open item of the goal. */
export interface DigestItem {
  key: string;
  /** Short label of the item; absent = none stored. */
  subject?: string;
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
  /** Newest plan version of the goal; absent = no plan. */
  planVersion?: number;
}

/** "45s" / "59m" / "2h" for a count of seconds (rounded down, so 3570 s never reads "60m"). */
function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/** The digest message: goal line, one bullet per open item, held items flagged, spend against the goal budget. */
export function renderDigest(f: DigestFacts, language: OwnerLanguage): string {
  const lines = f.items.map((i) => {
    const pct = i.percent === undefined ? "" : ` ${i.percent}%`;
    const note = i.note ? `, ${i.note}` : "";
    const held = i.held ? t(language, "digest.held") : "";
    return `- ${i.key}${i.subject ? ` "${i.subject}"` : ""}: ${i.status}${pct}${note}, ${ago(i.ageSeconds)}${held}`;
  });
  return [
    t(language, "digest.checkIn", { objective: f.objective }),
    t(language, "digest.done", { done: f.done, total: f.total }),
    ...lines,
    ...(f.planVersion ? [t(language, "digest.plan", { version: f.planVersion })] : []),
    t(language, "digest.spend", { spent: `$${f.spentUsd.toFixed(2)}`, budget: `$${f.budgetUsd}` }),
  ].join("\n");
}
