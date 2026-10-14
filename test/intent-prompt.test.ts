import { expect, test } from "bun:test";
import { buildIntentSystemPrompt } from "../src/intent/intent-prompt";
import { intentRoles } from "../src/roles/role-registry";

test("system prompt carries the class rubric, the standard default and the low-confidence rule", () => {
  const p = buildIntentSystemPrompt(intentRoles());
  expect(p).toContain("mechanical = ONLY");
  expect(p).toContain("standard = anything that adds or changes tests");
  expect(p).toContain("design = architecture");
  expect(p).toContain("choose standard");
  expect(p).toContain('confidence "low" ONLY');
});

test("class applies to every role: answering work has its own examples per class", () => {
  const p = buildIntentSystemPrompt(intentRoles());
  expect(p).toContain("class for every role");
  expect(p).not.toContain("only for a role that changes things");
  expect(p).toContain("Answers: greeting, one-fact lookup");
  expect(p).toContain("Answers: ordinary explanation, search, summary");
  expect(p).toContain("Answers: deep multi-file reasoning, cross-module comparison, long analysis");
});

/** Length of the L3 system prompt before the outcome rule (P1 baseline, 4617 chars) + the 25% budget (5771; was 15% before the busy-thread control rule). */
const PROMPT_BASELINE = 4617;
const PROMPT_BUDGET = Math.floor(PROMPT_BASELINE * 1.25);

test("role list carries every whenToUse; prompt stays within +25% of the baseline", () => {
  const roles = intentRoles();
  const p = buildIntentSystemPrompt(roles);
  for (const r of roles) expect(p).toContain(`- ${r.name}: ${r.whenToUse}`);
  expect(p.length).toBeLessThanOrEqual(PROMPT_BUDGET);
});

test("prompt states the control field: explicit stop / replace only, high confidence, never from a supplement", () => {
  const p = buildIntentSystemPrompt(intentRoles());
  expect(p).toContain('"control"');
  expect(p).toContain("explicitly");
  expect(p).toContain("replace");
});
