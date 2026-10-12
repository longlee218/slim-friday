import type { Database } from "bun:sqlite";
import { type Route, TASK_BUDGET_USD } from "../../config/model-routing";
import { logEvent, logger } from "../../observability/logger";
import { clip, redactText } from "../../observability/redact";
import { spentByOtherStages } from "../../storage/stage-store";

/* Budget hit (outcome `max_budget`): the owner-facing text, never silent, always says what happened. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "budget" });

/**
 * Run ceiling (`TASK_BUDGET_USD`, per run: a `/go` re-run is a new turn row, so its spend starts again at 0): the run input
 * with `route.spentUsd` = what the turn's OTHER stages already cost, so
 * `resolveBudget` limits this stage to what is left. Unchanged when nothing was spent yet.
 */
export function withSpent<T extends { turnId: string; route?: Route }>(
  db: Database,
  i: T,
  idx: number,
): T {
  const spentUsd = spentByOtherStages(db, i.turnId, idx);
  return spentUsd > 0 ? { ...i, route: { ...i.route, spentUsd } } : i;
}

/** Owner text when the run ceiling is already used up by the other stages of this run: the stage is refused up front (no 0 budget). */
export const ceilingRefusal = (route?: Route): string | undefined =>
  (route?.spentUsd ?? 0) >= TASK_BUDGET_USD
    ? `Run ceiling reached: ${usd(TASK_BUDGET_USD)} already spent by this run's earlier stages. Nothing was started; \`/go +<usd>\` cannot lift this ceiling.`
    : undefined;

/** Facts of a stage that stopped on its budget. */
export interface BudgetHit {
  /** Cost of the run so far (USD); unknown when no result message carried it. */
  spentUsd?: number;
  /** The cap the run had; unknown (undefined) is stated as such. */
  limitUsd?: number;
  /** Last assistant text of the run (may be empty). */
  summary?: string;
  /** The task ceiling (TASK_BUDGET_USD), not the stage budget, was the limit: no raise is offered. */
  ceilingBound?: boolean;
  /** Raise offered to the owner: the message ends with "Reply `/go +<usd>`". */
  goPlusUsd?: number;
}

/** Cap of the quoted last summary (the owner reads a Discord reply, not a log). */
export const BUDGET_SUMMARY_MAX = 500;

const usd = (n: number | undefined): string => (n === undefined ? "?" : `$${n.toFixed(2)}`);

/**
 * The reply of a budget stop. States spent/limit, that the SDK checks between turns (a small overshoot is
 * possible) and the last summary; the `go +<usd>` line only when `goPlusUsd` is set
 * (resuming with the same budget would loop, so the hint carries a raise).
 */
export function budgetHitMessage(h: BudgetHit): string {
  const lines = [
    h.ceilingBound
      ? `Stopped: run ceiling ${usd(TASK_BUDGET_USD)} reached (this stage spent ${usd(h.spentUsd)} of the ${usd(h.limitUsd)} left; checked between turns, so a small overshoot is possible). \`/go +<usd>\` cannot lift the run ceiling.`
      : `Stopped: budget reached (${usd(h.spentUsd)} of ${usd(h.limitUsd)}; the limit is checked between turns, so a small overshoot is possible).`,
  ];
  if (h.summary?.trim()) lines.push(`Last summary:\n${clip(h.summary.trim(), BUDGET_SUMMARY_MAX)}`);
  if (h.goPlusUsd !== undefined) {
    lines.push(`Reply \`/go +${h.goPlusUsd}\` to continue with that much more budget.`);
  }
  return lines.join("\n");
}

/**
 * Reply of a stage run that stopped on its budget: logs `budget.exceeded` and words the stop (redacted):
 * spent/limit and the agent's last words. Offers the same amount
 * again: `go +<usd>` continues with that much more.
 */
export function budgetHitReply(res: {
  usage?: { costUsd?: number };
  budgetUsd?: number;
  ceilingBound?: boolean;
  lastText?: string;
}): string {
  logEvent(log, "budget.exceeded", {
    spentUsd: res.usage?.costUsd,
    limitUsd: res.budgetUsd ?? null,
  });
  return redactText(
    budgetHitMessage({
      spentUsd: res.usage?.costUsd,
      limitUsd: res.budgetUsd,
      summary: res.lastText,
      ceilingBound: res.ceilingBound,
      goPlusUsd:
        res.budgetUsd === undefined || res.ceilingBound
          ? undefined
          : Number(res.budgetUsd.toFixed(2)),
    }),
  );
}
