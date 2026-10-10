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
