import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// iOS Safari zooms into a focused field under 16px. Fields whose own rule sets a smaller size
// must be raised by name in the touch block of base.css.
test("touch screens raise the owner-file editor and mono fields to 16px", () => {
  const css = readFileSync("src/styles/base.css", "utf8");
  const block = css.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const raised = block.match(/:root :is\(([^)]*)\) \{ font-size: 16px; \}/)?.[1] ?? "";
  expect(raised).toContain(".of-edit");
  expect(raised).toContain(".field.mono");
});
