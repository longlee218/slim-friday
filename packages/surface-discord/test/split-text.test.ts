import { expect, test } from "bun:test";
import { splitText } from "../src/split-text";

test("short text is one chunk", () => {
  expect(splitText("hello")).toEqual(["hello"]);
});

test("long text is cut at line breaks, every chunk fits, nothing is lost", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(10)}`);
  const text = lines.join("\n");
  const chunks = splitText(text, 2000);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  expect(chunks.join("\n")).toBe(text);
});

test("a very long word is cut hard", () => {
  const chunks = splitText("a".repeat(4500), 2000);
  expect(chunks.map((c) => c.length)).toEqual([2000, 2000, 500]);
});

test("no empty chunks", () => {
  expect(splitText("a\n\n\nb", 3).every((c) => c.length > 0)).toBe(true);
});
