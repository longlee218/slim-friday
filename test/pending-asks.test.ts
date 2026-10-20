import { expect, test } from "bun:test";
import { closeThreadAsk, registerThreadAsk } from "../src/orchestrator/lead/pending-asks";

test("a plain message in the thread answers the lead's waiting ask once", () => {
  const got: string[] = [];
  registerThreadAsk("t1", (text) => got.push(text));
  expect(closeThreadAsk("t2", "x")).toBe(false); // another thread
  expect(closeThreadAsk("t1", "bạn tự chọn")).toBe(true);
  expect(closeThreadAsk("t1", "again")).toBe(false); // consumed
  expect(got).toEqual(["bạn tự chọn"]);
});

test("unregister removes the ask, so a later message goes to the lead", () => {
  const off = registerThreadAsk("t3", () => {});
  off();
  expect(closeThreadAsk("t3", "x")).toBe(false);
});
