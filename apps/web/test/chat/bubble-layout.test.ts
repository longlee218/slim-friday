import { expect, test } from "vitest";
import { isRichText } from "../../src/components/chat/bubble-layout";

test("code fences and tables are rich; plain text, lists and inline code are not", () => {
  expect(isRichText("Here:\n\n```ts\nx\n```")).toBe(true);
  expect(isRichText("| a | b |\n|---|:---:|\n| 1 | 2 |")).toBe(true);
  expect(isRichText("a | b\n--- | ---\n1 | 2")).toBe(true);
  expect(isRichText("Plain answer with `code` and a - dash")).toBe(false);
  expect(isRichText("- one\n- two\n\n---\n\nAfter a rule")).toBe(false);
});
