import { SUMMARY_MAX_CHARS } from "../storage/thread-summary-store";

/** Max chars of the previous summary kept in a merge (its newest end). */
const SUMMARY_PREV_KEEP_CHARS = 2500;
/** Share of the previous summary's distinctive words that must reappear in the new one to call it "already covered". */
const COVERED_SHARE = 0.6;
/** Words shorter than this are ignored by the coverage check. */
const MIN_WORD_CHARS = 5;
/** Words of the previous summary the coverage check looks at. */
const MAX_WORDS = 200;
const EARLIER = "Earlier: ";
const LATEST = "\n\nLatest: ";

/** Distinctive lowercase words of a text. */
const wordsOf = (t: string): string[] =>
  [
    ...new Set(
      t
        .normalize("NFC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ].filter((w) => w.length >= MIN_WORD_CHARS);

/** The previous summary without the `Earlier:` / `Latest:` labels of an earlier merge (labels never nest). */
const unlabel = (s: string): string =>
  s.startsWith(EARLIER) ? s.slice(EARLIER.length).replace(LATEST, "\n\n") : s;

/**
 * Thread summary after a mid-run compaction: previous summary + the SDK's new one, pure.
 * - No previous summary: the new one as is.
 * - The new one already covers the previous (a RESUMED session carries the earlier compaction summary inside
 *   its own transcript, so its new summary restates it): the new one as is, no duplicated text.
 * - Otherwise (a fresh session after a rollover: the old summary was only prompt context, so the SDK never saw
 *   it): `Earlier: <previous, newest SUMMARY_PREV_KEEP_CHARS>` + `Latest: <new>`, fitted to SUMMARY_MAX_CHARS
 *   with the OLD part giving way first.
 */
export function mergeSummary(previous: string, latest: string): string {
  const prev = unlabel(previous.trim());
  const next = latest.trim();
  if (!prev) return next;
  const words = wordsOf(prev).slice(0, MAX_WORDS);
  if (words.length > 0) {
    const have = new Set(wordsOf(next));
    const hits = words.filter((w) => have.has(w)).length;
    if (hits / words.length >= COVERED_SHARE) return next;
  }
  // One char of room for the ellipsis that marks a clipped old part.
  const room = SUMMARY_MAX_CHARS - EARLIER.length - LATEST.length - next.length - 1;
  const keep = Math.min(SUMMARY_PREV_KEEP_CHARS, room);
  if (keep <= 0) return next;
  return `${EARLIER}${prev.length > keep ? `…${prev.slice(-keep)}` : prev}${LATEST}${next}`;
}
