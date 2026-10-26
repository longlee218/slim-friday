import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("tokens.css carries the light and dark tints and the glass material", () => {
  const css = readFileSync("src/styles/tokens.css", "utf8");
  expect(css).toContain("--tint: #3d5af1");
  expect(css).toContain("--tint-fill: #4a66f5");
  expect(css).toContain("--glass-blur:");
  expect(css).toContain("--grad:");
  expect(css).toContain(':root[data-theme="dark"]');
  expect(css).toContain("@media (prefers-color-scheme: dark)");
  expect(css).toContain(':root:not([data-theme="light"])');
  expect(css).toContain("--insp-w: 320px");
});

test("base.css cuts motion to 1ms under Reduce Motion", () => {
  expect(readFileSync("src/styles/base.css", "utf8")).toMatch(
    /prefers-reduced-motion: reduce[\s\S]*animation-duration: 1ms !important[\s\S]*transition-duration: 1ms !important/,
  );
});

test("app.css aliases every colour token and the three radii", () => {
  const css = readFileSync("src/styles/app.css", "utf8");
  expect(css).toContain("--color-tint: var(--tint)");
  expect(css).toContain("--radius-bubble: 18px");
});
