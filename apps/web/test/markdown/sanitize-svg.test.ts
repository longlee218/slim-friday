import { expect, test } from "vitest";
import { sanitizeSvg } from "../../src/components/markdown/sanitize-svg";

test("strips scripts and handlers but keeps HTML labels in foreignObject", () => {
  const out = sanitizeSvg(
    '<svg onload="x()"><script>x()</script><foreignObject><div><span>Label</span></div></foreignObject></svg>',
  );
  expect(out).not.toContain("script");
  expect(out).not.toContain("onload");
  expect(out).toContain("<span>Label</span>");
});
