/**
 * Text folding for the memory index, applied IDENTICALLY to indexed text and to query terms.
 * FTS5 `unicode61 remove_diacritics 2` strips combining marks (so "quyết" matches "quyet") but does NOT treat
 * `đ` as a diacritic form of `d`; that one letter is mapped here. Lowercasing is done by the tokenizer.
 */

/** NFC-normalize (NFD input matches NFC text), then map `đ`/`Đ` to `d`/`D`. Same length as the NFC text. */
export const foldText = (s: string): string =>
  s.normalize("NFC").replace(/đ/g, "d").replace(/Đ/g, "D");

/** A search word: letters, digits and combining marks (the tokenizer's own word rule; everything else separates). */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
/** A word needs at least one letter or digit to be a token. */
const HAS_TOKEN_CHAR = /[\p{L}\p{N}]/u;

/**
 * Search terms of a free-text query: clipped to `maxChars`, folded, lowercased, split on non-word characters,
 * de-duplicated, at most `maxTerms`. Quotes, operators and column filters cannot survive the split.
 */
export function queryTerms(query: string, maxChars: number, maxTerms: number): string[] {
  const folded = foldText(query.slice(0, maxChars)).toLowerCase();
  const terms = new Set<string>();
  for (const m of folded.matchAll(WORD)) {
    if (HAS_TOKEN_CHAR.test(m[0])) terms.add(m[0]);
    if (terms.size >= maxTerms) break;
  }
  return [...terms];
}

/** FTS5 MATCH expression: every term a quoted string (inner quotes doubled), joined with OR. */
export const buildMatch = (terms: string[]): string =>
  terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
