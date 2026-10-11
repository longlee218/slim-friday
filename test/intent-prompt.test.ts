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

/** Length of the L3 system prompt before the outcome rule (P1 baseline, 4617 chars) + the 15% budget (5310). */
const PROMPT_BASELINE = 4617;
const PROMPT_BUDGET = Math.floor(PROMPT_BASELINE * 1.15);

test("role list carries every whenToUse; prompt stays within +15% of the baseline", () => {
  const roles = intentRoles();
  const p = buildIntentSystemPrompt(roles);
  for (const r of roles) expect(p).toContain(`- ${r.name}: ${r.whenToUse}`);
  expect(p.length).toBeLessThanOrEqual(PROMPT_BUDGET);
});
