import { expect, test } from "bun:test";
import { computerContextBlock } from "../../src/hub/computer-context-block";
import { bot } from "../bot-hub-harness";

test("no block for a bot without a computer", () => {
  expect(computerContextBlock(bot("editor", "Editor"))).toBeUndefined();
});

test("the block names the computer and has no slot line", () => {
  const text = computerContextBlock({ ...bot("editor", "Editor"), computer: "home" });
  expect(text).toStartWith("<computer>\n");
  expect(text).toEndWith("\n</computer>");
  expect(text).toContain('Linux computer named "home"');
  expect(text).not.toContain("lots");
});
