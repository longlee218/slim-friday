import { expect, test } from "bun:test";
import type { IntentDecision } from "../src/intent/decide-intent";
import { DISCUSSION_CASES } from "./intent-eval-cases-discussion";
import { roleMatches } from "./intent-eval-score";

const dev: IntentDecision = { kind: "role", role: "dev", scope: "new" };
const devConfirm: IntentDecision = { ...dev, confirmDev: true } as IntentDecision;
const assistant: IntentDecision = { kind: "role", role: "assistant", scope: "new" };

test("roleMatches: plain dev is a miss, dev + confirmDev is ok only with orDevConfirm", () => {
  const strict = { role: "assistant" };
  const lenient = { role: "assistant", orDevConfirm: true } as const;
  expect(roleMatches(assistant, strict)).toBe(true);
  expect(roleMatches(devConfirm, strict)).toBe(false); // not accepted unless the case opts in
  expect(roleMatches(dev, lenient)).toBe(false); // a plain dev start stays a miss
  expect(roleMatches(devConfirm, lenient)).toBe(true);
  expect(roleMatches(assistant, lenient)).toBe(true);
  expect(roleMatches({ kind: "ask", reason: "low_confidence" }, lenient)).toBe(false);
});

test("exactly the two proposal-after-analysis discussion cases accept dev + confirm", () => {
  const lenient = DISCUSSION_CASES.filter((c) => c.expect.orDevConfirm);
  expect(lenient.map((c) => c.text.split(/[,?]/)[0])).toEqual([
    "Friday có thể nhớ ngữ cảnh giữa các luồng không",
    "Dựa trên phân tích trên",
  ]);
});
