import { expect, test } from "vitest";
import {
  canSend,
  checkFiles,
  composerMaxHeight,
  sendOnEnter,
} from "../../src/components/chat/composer-rules";

const f = (name: string, size: number) => ({ name, size });
const k = (key: string, extra: Partial<{ shiftKey: boolean; isComposing: boolean }> = {}) => ({
  key,
  shiftKey: false,
  isComposing: false,
  ...extra,
});

test("checkFiles refuses a sixth file and a 21 MB file", () => {
  expect(checkFiles(5, [f("a", 1)])).toEqual({ ok: false, error: "Up to 5 files per message." });
  expect(checkFiles(0, [f("big.mov", 21 * 1024 * 1024)])).toEqual({
    ok: false,
    error: "big.mov is over 20 MB.",
  });
  expect(checkFiles(0, [f("ok.bin", 20 * 1024 * 1024)])).toEqual({ ok: true });
});

test("checkFiles refuses an empty file (the server does too)", () => {
  expect(checkFiles(0, [f("e.txt", 0)])).toEqual({ ok: false, error: "e.txt is empty." });
});

test("canSend waits for uploads", () => {
  expect(canSend({ text: "hi", uploads: [{ state: "uploading" }] })).toBe(false);
  expect(canSend({ text: "hi", uploads: [{ state: "failed" }] })).toBe(false);
  expect(canSend({ text: " ", uploads: [{ state: "done" }] })).toBe(true);
  expect(canSend({ text: "  ", uploads: [] })).toBe(false);
});

test("Enter sends on desktop, never on phone or while composing", () => {
  expect(sendOnEnter(k("Enter"), false)).toBe(true);
  expect(sendOnEnter(k("Enter", { shiftKey: true }), false)).toBe(false);
  expect(sendOnEnter(k("Enter"), true)).toBe(false);
  expect(sendOnEnter(k("Enter", { isComposing: true }), false)).toBe(false);
  expect(sendOnEnter(k("a"), false)).toBe(false);
});

test("max height 200 desktop, 120 phone", () => {
  expect(composerMaxHeight(false)).toBe(200);
  expect(composerMaxHeight(true)).toBe(120);
});
