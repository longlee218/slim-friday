import { expect, test } from "bun:test";
import { computerContextBlock } from "../../src/hub/computer-context-block";
import { bot } from "../bot-hub-harness";

test("no block for a bot without a computer", () => {
  expect(computerContextBlock(bot("editor", "Editor"), "2 slots")).toBeUndefined();
});

test("the block names the computer and the slots", () => {
  const text = computerContextBlock({ ...bot("editor", "Editor"), computer: "home" }, "2 slots");
  expect(text).toStartWith("<computer>\n");
  expect(text).toEndWith("\n</computer>");
  expect(text).toContain('Linux computer named "home"');
  expect(text).toContain("Slots on this machine: 2 slots.");
});
