import { expect, test } from "bun:test";
import { summarizeResult } from "../src/observability/tool-result-summary";

test("Read result: lines from file.numLines, chars = content length (exact), no content copied", () => {
  const out = { type: "text", file: { content: 'SECRET\n"BODY"', numLines: 90, startLine: 1 } };
  const r = summarizeResult(out, false);
  expect(r.lines).toBe(90);
  expect(r.chars).toBe('SECRET\n"BODY"'.length);
  expect(r.approx).toBeUndefined();
  expect(JSON.stringify(r)).not.toContain("SECRET");
});

test("Grep/Glob result: numLines, numFiles, truncated", () => {
  expect(summarizeResult({ numFiles: 3, numLines: 12, truncated: true }, false)).toMatchObject({
    files: 3,
    lines: 12,
    truncated: true,
  });
  expect(summarizeResult({ numFiles: 3, truncated: false }, false).truncated).toBeUndefined();
});

test("Bash result: chars = stdout + stderr", () => {
  expect(summarizeResult({ stdout: "abc", stderr: "de" }, false).chars).toBe(5);
});

test("MCP result: chars = sum of text parts", () => {
  const r = summarizeResult(
    { content: [{ type: "text", text: "abcd" }, { type: "image" }] },
    false,
  );
  expect(r.chars).toBe(4);
});

test("string result: chars = length", () => {
  expect(summarizeResult("hello", false)).toEqual({ chars: 5 });
});

test("error: redacted text capped at 200 chars", () => {
  const r = summarizeResult(`failed password: hunter2 ${"x".repeat(500)}`, true);
  expect(r.err).not.toContain("hunter2");
  expect(r.err!.length).toBeLessThanOrEqual(200);
});

test("circular object: no throw, chars undefined", () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  expect(summarizeResult(a, false).chars).toBeUndefined();
});

test("undefined output: empty summary", () => {
  expect(summarizeResult(undefined, false)).toEqual({});
});

test("unknown object shape: text volume, marked approx, JSON.stringify never called on it", () => {
  const out = { content: "abcdef", filenames: ["a.ts", "bb.ts"] };
  const toJSON = () => {
    throw new Error("serialized");
  };
  expect(summarizeResult({ ...out, toJSON }, false)).toMatchObject({ chars: 15, approx: true });
});

test("huge nested object: bounded work", () => {
  let deep: unknown = "x";
  for (let i = 0; i < 100; i++) deep = { a: deep };
  expect(summarizeResult(deep, false).chars).toBeUndefined();
});
