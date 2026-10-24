/** Longest summary shown on a card, in code points. */
const SUMMARY_MAX = 1200;

/**
 * Flatten a model-written summary (backticks and line breaks cannot fake the card) and cut it,
 * saying how much was cut. Cuts by code points so no surrogate pair is split.
 */
export function flattenSummary(summary: string): string {
  const points = [...summary.replace(/[`\r\n]+/g, " ")];
  return points.length > SUMMARY_MAX
    ? `${points.slice(0, SUMMARY_MAX).join("")} [CUT: ${points.length - SUMMARY_MAX} more chars]`
    : points.join("");
}
