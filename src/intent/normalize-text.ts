/**
 * Text normalization shared by the intent layers L1-L3 (pure, no I/O).
 * Messages AND lexicon phrases go through the same functions, so one list covers accented and plain input.
 */

/** Token that marks a sentence / clause boundary: negation never reaches across it, phrases never contain it. */
export const BOUNDARY = "|";

/** Fenced code block; an unterminated fence swallows the rest of the message. */
const FENCE = /```[\s\S]*?(?:```|$)/g;
/** Inline code between single backticks (one line). */
const INLINE_CODE = /`[^`\n]*`/g;
/** Lines that are pasted material, not the owner's words: timestamps, stack frames, shell prompts, quotes. */
const PASTED_LINE: readonly RegExp[] = [
  /^\s*\[?\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/, // 2026-10-10 12:00 / [2026-10-10T...
  /^\s*\[?\d{2}:\d{2}:\d{2}/, // 12:00:01 ...
  /^\s*at\s+\S.*:\d+/, // "at fn (file.ts:12:3)" stack frame
  /^\s*\$ /, // shell prompt
  /^\s*>/, // Discord quote of an earlier message
];

/** Drop code and pasted logs; each removed block becomes a line break so words never glue together. */
export function stripIgnored(text: string): string {
  const noCode = text.replace(FENCE, "\n").replace(INLINE_CODE, " ");
  return noCode
    .split(/\r?\n/)
    .map((line) => (PASTED_LINE.some((re) => re.test(line)) ? "" : line))
    .join("\n");
}

/**
 * NFC, lowercase, accent-insensitive (combining marks removed, đ -> d), as tokens of [a-z0-9].
 * Sentence punctuation and line breaks become BOUNDARY tokens; every other symbol is just a separator.
 */
export function tokenizePhrase(text: string): string[] {
  const plain = text
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d");
  return plain
    .replace(/[.!?;,:…\r\n]+/g, ` ${BOUNDARY} `)
    .replace(/[^a-z0-9|]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Owner message -> tokens: ignored blocks removed first, then normalized. */
export function tokenizeMessage(text: string): string[] {
  return tokenizePhrase(stripIgnored(text));
}
