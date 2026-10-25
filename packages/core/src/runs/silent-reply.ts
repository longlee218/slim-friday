/** The text a bot writes as its whole final reply to stay silent (spec §6.3, R§6). */
export const SILENT_SENTINEL = "NO_RESPONSE";

/** True when the text is only the sentinel (repeated is fine), with nothing but whitespace around it. */
export function isSilent(text: string): boolean {
  return /^(?:NO_RESPONSE\s*)+$/.test(text.trim());
}

/**
 * The text with a sentinel at its start or end removed and trimmed; a sentinel inside prose, or as part of a
 * longer word (`FOO_NO_RESPONSE`, `NO_RESPONSES`), stays.
 */
export function stripSentinel(text: string): string {
  return text
    .trim()
    .replace(/^(?:NO_RESPONSE\b\s*)+/, "")
    .replace(/(?:\s*\bNO_RESPONSE)+$/, "")
    .trim();
}
