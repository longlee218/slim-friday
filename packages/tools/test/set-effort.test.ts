import { expect, test } from "bun:test";
import type { EffortLevel } from "@friday/core";
import type { ChatContext } from "../src/chat/chat-context";
import { createSetEffortTool } from "../src/chat/tools/SetEffortTool/set-effort-tool";
import { call, textOf } from "./design-fixture";

/** A tool whose context allows up to `max` and records the levels applied. */
function make(max?: EffortLevel, fail = false) {
  const applied: EffortLevel[] = [];
  const effort: ChatContext["effort"] = {
    max,
    apply: async (l) => {
      if (fail) throw new Error("boom");
      applied.push(l);
    },
  };
  return { tool: createSetEffortTool({ effort } as ChatContext), applied };
}

test("SetEffort applies a level up to the ceiling and refuses above it", async () => {
  const { tool, applied } = make("high");
  expect((await call(tool, { level: "high" })).isError).toBeUndefined();
  expect((await call(tool, { level: "low" })).isError).toBeUndefined();
  const over = await call(tool, { level: "max" });
  expect(over.isError).toBe(true);
  expect(textOf(over)).toContain("high");
  expect(applied).toEqual(["high", "low"]);
});

test("SetEffort is refused without a ceiling and when the session cannot apply it", async () => {
  const none = make(undefined);
  expect((await call(none.tool, { level: "low" })).isError).toBe(true);
  const broken = make("max", true);
  expect((await call(broken.tool, { level: "low" })).isError).toBe(true);
});
