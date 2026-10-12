import { expect, test } from "bun:test";
import { BUDGET_SUMMARY_MAX, budgetHitMessage } from "../src/orchestrator/engine/budget";

// Budget-hit message parts.

test("budget message: caps the summary, keeps the overshoot note and the go offer; no diff stat (the app runs no git on the repo)", () => {
  const text = budgetHitMessage({
    spentUsd: 3.21,
    limitUsd: 3,
    summary: "x".repeat(5000),
    goPlusUsd: 3,
  });
  expect(text).toContain("$3.21 of $3.00");
  expect(text).toContain("small overshoot");
  expect(text).toContain("`/go +3`");
  expect(text).not.toContain("Changes so far");
  expect(text.length).toBeLessThan(BUDGET_SUMMARY_MAX + 600);
});

test("budget message without summary / limit: only the facts that are known", () => {
  const text = budgetHitMessage({});
  expect(text).toContain("? of ?");
  expect(text).not.toContain("Last summary");
  expect(text).not.toContain("Changes so far");
  expect(text).not.toContain("/go +");
});

test("ceiling-bound stop says the ceiling is per run", () => {
  const text = budgetHitMessage({ spentUsd: 1, limitUsd: 2, ceilingBound: true });
  expect(text).toContain("run ceiling");
  expect(text).not.toContain("task ceiling");
});
