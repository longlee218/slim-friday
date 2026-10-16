import { expect, test } from "bun:test";
import { BUDGET_SUMMARY_MAX, budgetHitMessage } from "../src/orchestrator/engine/budget";

// Budget-hit message parts.

test("budget message: caps the summary, keeps the overshoot note; no diff stat (the app runs no git on the location)", () => {
  const text = budgetHitMessage(
    {
      spentUsd: 3.21,
      limitUsd: 3,
      summary: "x".repeat(5000),
    },
    "en",
  );
  expect(text).toContain("allowed spending limit was reached");
  expect(text).not.toContain("Changes so far");
  expect(text.length).toBeLessThan(BUDGET_SUMMARY_MAX + 300);
});

test("budget message without summary / limit: only the facts that are known", () => {
  const text = budgetHitMessage({}, "en");
  expect(text).toContain("did not finish");
  expect(text).not.toContain("Last summary");
  expect(text).not.toContain("Changes so far");
});

test("ceiling-bound stop says the ceiling is the task's (its resumes share it) and says it cannot be raised", () => {
  const text = budgetHitMessage({ spentUsd: 1, limitUsd: 2, ceilingBound: true }, "en");
  expect(text).toContain("spending limit");
  expect(text).toContain("cannot be raised");
});
