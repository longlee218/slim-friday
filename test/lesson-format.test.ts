import { expect, test } from "bun:test";
import { formatLesson, isStructuredLesson } from "../src/memory/lesson-format";

test("formatLesson writes one line and does not double a leading When", () => {
  const line = formatLesson({
    cue: "When a build\n fails on lint",
    lesson: "run the formatter first",
    evidence: "goal ab12 fix-1",
  });
  expect(line).toBe(
    "When a build fails on lint: run the formatter first — evidence: goal ab12 fix-1",
  );
  expect(isStructuredLesson(line)).toBe(true);
});

test("isStructuredLesson refuses a lesson without cue or evidence", () => {
  expect(isStructuredLesson("Always run migrations.")).toBe(false);
  expect(isStructuredLesson("When x: do y")).toBe(false);
  expect(isStructuredLesson("When x: do y — evidence: ")).toBe(false);
});
