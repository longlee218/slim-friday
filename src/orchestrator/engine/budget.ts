import { logEvent, logger } from "../../observability/logger";
import { redactText } from "../../observability/redact";

/* Budget hit (outcome `max_budget`): the owner-facing text, never silent, always says what happened. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "budget" });

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
  /** Raise offered to the owner: the message ends with "Reply `go +<usd>`". */
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

/**
 * Reply of a stage run that stopped on its budget: logs `budget.exceeded` and words the stop (redacted).
 * `res.text` holds SDK error strings here, not an assistant summary, so no summary / diff stat is passed yet.
 * Offers the same amount again: `go +<usd>` resumes the kept session with that much more.
 */
export function budgetHitReply(res: { usage?: { costUsd?: number }; budgetUsd?: number }): string {
  logEvent(log, "budget.exceeded", {
    spentUsd: res.usage?.costUsd,
    limitUsd: res.budgetUsd ?? null,
  });
  return redactText(
    budgetHitMessage({
      spentUsd: res.usage?.costUsd,
      limitUsd: res.budgetUsd,
      goPlusUsd: res.budgetUsd === undefined ? undefined : Number(res.budgetUsd.toFixed(2)),
    }),
  );
}
