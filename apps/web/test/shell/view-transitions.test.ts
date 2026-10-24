import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8");

test("view-transition rules for the main pane and inspector are present", () => {
  expect(css).toContain(
    "::view-transition-old(main-content) { animation: vtOut 140ms ease both; }",
  );
  expect(css).toContain(
    "::view-transition-new(main-content) { animation: vtIn 300ms var(--ease) both; }",
  );
  expect(css).toContain("::view-transition-new(insp) { animation: vtInX 320ms var(--ease) both; }");
  expect(css).toContain(
    "::view-transition-old(root), ::view-transition-new(root) { animation: none; }",
  );
  expect(css).toMatch(/\.inspector \{ view-transition-name: insp; \}/);
  expect(css).toMatch(/\.main-vt \{ view-transition-name: main-content;/);
});
