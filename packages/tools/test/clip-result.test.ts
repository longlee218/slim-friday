import { expect, test } from "bun:test";
import { clipResult } from "../src/clip-result";
import { textResult } from "../src/tool-result";

test("text over the limit is cut to the limit plus a marker with the cut count", () => {
  const out = clipResult("a".repeat(20_000));
  expect(out.startsWith("a".repeat(12_000))).toBe(true);
  expect(out.slice(12_000)).toBe("\n[cut: 8000 more chars; narrow the request]");
});

test("short text is unchanged", () => {
  expect(clipResult("hello")).toBe("hello");
  expect(clipResult("a".repeat(12_000))).toBe("a".repeat(12_000));
});

test("a surrogate pair at the boundary is not split", () => {
  const text = `${"a".repeat(11_999)}😀${"b".repeat(100)}`;
  const out = clipResult(text);
  const head = out.slice(0, out.indexOf("\n"));
  expect(head).toBe("a".repeat(11_999));
  expect(out.endsWith("\n[cut: 102 more chars; narrow the request]")).toBe(true);
});

test("textResult clips ok and error results", () => {
  const ok = textResult("x".repeat(20_000));
  expect(ok.content[0]?.text.length).toBeLessThan(12_200);
  const err = textResult("y".repeat(20_000), true);
  expect(err.isError).toBe(true);
  expect(err.content[0]?.text).toContain("[cut: 8000 more chars; narrow the request]");
});
