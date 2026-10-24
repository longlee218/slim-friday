/** Shortest note (characters, trimmed) that can say anything. */
const MIN_CHARS = 10;
/** Share of words two notes have in common (Jaccard) from which they count as the same note. */
const SAME_NOTE = 0.8;

/** Why a note is refused, or `keep`. */
export type Worth = "keep" | "too_short" | "near_duplicate";

/** Words of `text`, lower case and without diacritics (`đ` is `d`), one-letter words dropped. */
function words(text: string): Set<string> {
  const folded = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d");
  return new Set(folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
}

/** Jaccard similarity of two word sets (1 = same words, 0 = nothing shared). */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Cheap check, done in code and not by the model, before a note is promoted into MEMORY.md: too short to mean
 * anything, or the same note as one already kept (`existing`) apart from case, punctuation, diacritics or a word or
 * two. A different wording of the same fact is the model's job (the consolidation prompt), not this check's.
 */
export function worthKeeping(note: string, existing: string[]): Worth {
  if (note.trim().length < MIN_CHARS) return "too_short";
  const mine = words(note);
  return existing.some((e) => similarity(mine, words(e)) >= SAME_NOTE) ? "near_duplicate" : "keep";
}
