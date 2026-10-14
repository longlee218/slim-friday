import { expect, test } from "bun:test";
import type { IntentDecision } from "../src/intent/decide-intent";
import { roleMatches } from "./intent-eval-score";

const dev: IntentDecision = { kind: "role", role: "dev", scope: "new" };
const assistant: IntentDecision = { kind: "role", role: "assistant", scope: "new" };

test("roleMatches: only the expected role matches", () => {
  const strict = { role: "assistant" };
  expect(roleMatches(assistant, strict)).toBe(true);
  expect(roleMatches(dev, strict)).toBe(false);
  expect(roleMatches({ kind: "ask", reason: "low_confidence" }, strict)).toBe(false);
});
