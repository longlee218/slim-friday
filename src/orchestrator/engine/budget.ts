import type { Database } from "bun:sqlite";
import { type Route, TASK_BUDGET_USD } from "../../config/model-routing";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { logEvent, logger } from "../../observability/logger";
import { clip, redactText } from "../../observability/redact";
import { spentByTask } from "../../storage/run-metrics-store";

/* Budget hit (outcome `max_budget`): the owner-facing text, never silent, always says what happened. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "budget" });

/**
 * Task ceiling (`TASK_BUDGET_USD`): the run input with `route.spentUsd` = what the task's earlier runs already cost (its
 * own and the runs it resumes), so `resolveBudget` limits this run to what is left. Unchanged
 * when nothing was spent yet.
 */
export function withSpent<T extends { turnId: string; route?: Route }>(db: Database, i: T): T {
  const spentUsd = spentByTask(db, i.turnId);
  return spentUsd > 0 ? { ...i, route: { ...i.route, spentUsd } } : i;
}

/** Owner text when the task ceiling is already used up by the task's earlier runs: the run is refused up front (no 0 budget). */
export const ceilingRefusal = (
  route: Route | undefined,
  language: OwnerLanguage,
): string | undefined =>
  (route?.spentUsd ?? 0) >= TASK_BUDGET_USD
    ? renderUserNotice({ kind: "failure", cause: "ceiling" }, language)
    : undefined;

/** Facts of a run that stopped on its budget. */
export interface BudgetHit {
  /** Cost of the run so far (USD); unknown when no result message carried it. */
  spentUsd?: number;
  /** The cap the run had; unknown (undefined) is stated as such. */
  limitUsd?: number;
  /** Last assistant text of the run (may be empty). */
  summary?: string;
  /** The task ceiling (TASK_BUDGET_USD), not the role budget, was the limit: no raise is offered. */
  ceilingBound?: boolean;
}

/** Cap of the quoted last summary (the owner reads a Discord reply, not a log). */
export const BUDGET_SUMMARY_MAX = 500;

/**
 * The reply of a budget stop. States spent/limit, that the SDK checks between turns (a small overshoot is
 * possible) and the last summary; a ceiling-bound stop says the limit cannot be raised.
 */
export function budgetHitMessage(h: BudgetHit, language: OwnerLanguage): string {
  const lines = [renderUserNotice({ kind: "outcome", outcome: "max_budget" }, language)];
  if (h.summary?.trim()) lines.push(clip(h.summary.trim(), BUDGET_SUMMARY_MAX));
  // A ceiling-bound stop cannot be raised: say what to do instead.
  if (h.ceilingBound)
    lines.push(
      language === "vi"
        ? "Giới hạn này không thể tăng thêm; bạn hãy gửi một yêu cầu mới để làm tiếp."
        : "This limit cannot be raised; send a new request to carry on.",
    );
  return lines.join("\n");
}

/**
 * Reply of a run that stopped on its budget: logs `budget.exceeded` and words the stop (redacted):
 * spent/limit and the agent's last words.
 */
export function budgetHitReply(
  res: {
    usage?: { costUsd?: number };
    budgetUsd?: number;
    ceilingBound?: boolean;
    lastText?: string;
  },
  language: OwnerLanguage,
): string {
  logEvent(log, "budget.exceeded", {
    spentUsd: res.usage?.costUsd,
    limitUsd: res.budgetUsd ?? null,
  });
  return redactText(
    budgetHitMessage(
      {
        spentUsd: res.usage?.costUsd,
        limitUsd: res.budgetUsd,
        summary: res.lastText,
        ceilingBound: res.ceilingBound,
      },
      language,
    ),
  );
}
