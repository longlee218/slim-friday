/* Owner-facing text of a budget hit (outcome `max_budget`): never silent, always says what happened. */

/** Facts of a stage that stopped on its budget. */
export interface BudgetHit {
  /** Cost of the run so far (USD); unknown when no result message carried it. */
  spentUsd?: number;
  /** The cap the run had; unknown (undefined) is stated as such. */
  limitUsd?: number;
  /** Last assistant text of the run (may be empty). */
  summary?: string;
  /** `git diff --stat` of the clone (P2.1 safe git; the stage runner passes it from P1.4). */
  diffStat?: string;
  /** Raise offered to the owner: the message ends with "Reply `go +<usd>`" (the `go` parser lands in P1.4). */
  goPlusUsd?: number;
}

const usd = (n: number | undefined): string => (n === undefined ? "?" : `$${n.toFixed(2)}`);

/**
 * The reply of a budget stop. States spent/limit, that the SDK checks between turns (a small overshoot is
 * possible), the last summary and the diff stat when known; the `go +<usd>` line only when `goPlusUsd` is set
 * (resuming with the same budget would loop, so the hint carries a raise).
 */
export function budgetHitMessage(h: BudgetHit): string {
  const lines = [
    `Stopped: budget reached (${usd(h.spentUsd)} of ${usd(h.limitUsd)}; the limit is checked between turns, so a small overshoot is possible). The session is kept.`,
  ];
  if (h.summary?.trim()) lines.push(`Last summary:\n${h.summary.trim()}`);
  if (h.diffStat?.trim()) lines.push(`Changes so far:\n${h.diffStat.trim()}`);
  if (h.goPlusUsd !== undefined) {
    lines.push(`Reply \`go +${h.goPlusUsd}\` to continue with that much more budget.`);
  }
  return lines.join("\n");
}
