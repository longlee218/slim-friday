import { render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { CodeBlock } from "../../src/components/markdown/code-block";

// No mocks: real shiki, real language table.

test("hostile code stays text after real highlighting", async () => {
  const code = "</code><script>alert(1)</script><img src=x onerror=alert(1)>";
  const { container } = render(<CodeBlock code={code} lang="html" />);
  await waitFor(() => expect(container.querySelector("pre.shiki")).not.toBeNull(), {
    timeout: 5000,
  });
  expect(container.querySelector("script, img")).toBeNull();
  expect(container.querySelector("pre.shiki")?.textContent).toContain("<script>alert(1)</script>");
});

test("a __proto__ fence stays plain and later fences still highlight", async () => {
  const bad = render(<CodeBlock code="x" lang="__proto__" />);
  await new Promise((r) => setTimeout(r, 100));
  expect(bad.container.querySelector("pre.shiki")).toBeNull();
  expect(bad.container.querySelector("pre")?.textContent).toBe("x");
  const ok = render(<CodeBlock code="const a = 1;" lang="ts" />);
  await waitFor(() => expect(ok.container.querySelector("pre.shiki")).not.toBeNull(), {
    timeout: 5000,
  });
});
