import { expect, test } from "bun:test";
import {
  BUDGET_SUMMARY_MAX,
  budgetHitMessage,
  budgetHitReply,
} from "../src/orchestrator/engine/budget";

// Budget-hit message parts.

test("budget message: caps the summary, keeps the overshoot note and the go offer; no diff stat (the app runs no git on the location)", () => {
  const text = budgetHitMessage({
    spentUsd: 3.21,
    limitUsd: 3,
    summary: "x".repeat(5000),
    goPlusUsd: 3,
  });
  expect(text).toContain("allowed spending limit was reached");
  expect(text).toContain("`/go +3`");
  expect(text).not.toContain("Changes so far");
  expect(text.length).toBeLessThan(BUDGET_SUMMARY_MAX + 300);
});

test("budget message without summary / limit: only the facts that are known", () => {
  const text = budgetHitMessage({});
  expect(text).toContain("did not finish");
  expect(text).not.toContain("Last summary");
  expect(text).not.toContain("Changes so far");
  expect(text).not.toContain("/go +");
});

test("ceiling-bound stop says the ceiling is the task's (its resumes share it) and offers no raise", () => {
  const text = budgetHitMessage({ spentUsd: 1, limitUsd: 2, ceilingBound: true });
  expect(text).toContain("spending limit");
  expect(text).not.toContain("/go +");
});

test("budgetHitReply: the offered raise is capped by what the task ceiling leaves, and says so", () => {
  // 4.00 spent by earlier runs + 1.50 by this one: 0.50 of the 6.00 task ceiling is left.
  const text = budgetHitReply({
    usage: { costUsd: 1.5 } as never,
    budgetUsd: 1.5,
    spentBeforeUsd: 4,
  });
  expect(text).toContain("`/go +0.5`");
  // Plenty left: the role budget is offered, no ceiling line.
  const free = budgetHitReply({ usage: { costUsd: 1.5 } as never, budgetUsd: 1.5 });
  expect(free).toContain("`/go +1.5`");
  expect(free).not.toContain("leaves only");
  // Nothing left: no raise.
  expect(
    budgetHitReply({ usage: { costUsd: 2 } as never, budgetUsd: 2, spentBeforeUsd: 4 }),
  ).not.toContain("/go +");
});
