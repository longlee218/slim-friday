import { BOUNDARY } from "./normalize-text";

/** How many tokens before a phrase may carry a negation ("khong sai roi", "dung lam lai"). */
export const NEGATION_WINDOW = 3;

/** Normalized negators (`dung` covers both "đừng" and "đúng": the accent-free form is ambiguous on purpose). */
const NEGATORS: ReadonlySet<string> = new Set([
  "khong",
  "ko",
  "chua",
  "chang",
  "dung",
  "not",
  "no",
  "never",
  "don",
]);

/** A weak (single, ambiguous) word counts this much; a group fires from weak words at WEAK_THRESHOLD. */
export const WEAK_WEIGHT = 0.5;
export const WEAK_THRESHOLD = 1;

/** True when one of the NEGATION_WINDOW tokens before `start` is a negator, stopping at a clause boundary. */
function negatedAt(tokens: readonly string[], start: number): boolean {
  for (let j = start - 1; j >= Math.max(0, start - NEGATION_WINDOW); j--) {
    const t = tokens[j] as string;
    if (t === BOUNDARY) return false;
    if (NEGATORS.has(t)) return true;
  }
  return false;
}

/** Phrase occurs on word boundaries (token-wise) at least once WITHOUT a negator in front. */
export function matchesPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  const n = phrase.length;
  for (let i = 0; i + n <= tokens.length; i++) {
    if (phrase.every((p, k) => tokens[i + k] === p) && !negatedAt(tokens, i)) return true;
  }
  return false;
}

/** The phrases (as indexes into `phrases`) that match un-negated. */
export function matchPhrases(
  tokens: readonly string[],
  phrases: readonly (readonly string[])[],
): number[] {
  const hits: number[] = [];
  phrases.forEach((p, i) => {
    if (matchesPhrase(tokens, p)) hits.push(i);
  });
  return hits;
}

/**
 * A group fires on ONE strong phrase, or on weak words adding up to WEAK_THRESHOLD (two distinct weak words).
 * So an ambiguous word ("thiet ke", "sai") never fires alone.
 */
export function groupFires(
  tokens: readonly string[],
  strong: readonly (readonly string[])[],
  weak: readonly (readonly string[])[] = [],
): boolean {
  if (strong.some((p) => matchesPhrase(tokens, p))) return true;
  return matchPhrases(tokens, weak).length * WEAK_WEIGHT >= WEAK_THRESHOLD;
}
