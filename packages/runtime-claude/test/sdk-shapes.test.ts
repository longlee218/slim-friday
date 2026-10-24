import { expect, test } from "bun:test";
import {
  ASK_INPUT_MULTI,
  ASK_INPUT_SINGLE,
  ASK_RESULT_FREE_TEXT,
  ASK_RESULT_MULTI_TEXT,
  ASK_RESULT_TEXT,
  ASSISTANT_SUBAGENT_TOOL_USE,
  ASSISTANT_THINKING,
  ASSISTANT_TOOL_USE,
  SPIKE,
  TASK_STARTED,
  USER_TOOL_RESULT_ERROR,
  USER_TOOL_RESULT_OK,
} from "./fixtures/sdk-shapes";

type Any = any;

test("main-thread tool_use block has id, name, input", () => {
  const m = ASSISTANT_TOOL_USE as Any;
  const b = m.message.content.find((c: Any) => c.type === "tool_use");
  expect(m.parent_tool_use_id).toBeNull();
  expect(typeof b.id).toBe("string");
  expect(b.name).toBe("Read");
  expect(typeof b.input.file_path).toBe("string");
});

test("a subagent message names the Agent tool_use that started it", () => {
  expect(typeof (ASSISTANT_SUBAGENT_TOOL_USE as Any).parent_tool_use_id).toBe("string");
});

test("tool_result carries tool_use_id and is_error", () => {
  const ok = (USER_TOOL_RESULT_OK as Any).message.content[0];
  const bad = (USER_TOOL_RESULT_ERROR as Any).message.content[0];
  expect(ok.type).toBe("tool_result");
  expect(typeof ok.tool_use_id).toBe("string");
  expect(ok.is_error ?? false).toBe(false);
  expect(bad.is_error).toBe(true);
});

test("AskUserQuestion input has questions with options and multiSelect", () => {
  // Not toMatchObject with expect.any: Bun writes the matcher into the fixture, which the ask tests share.
  expect(typeof ASK_INPUT_SINGLE.questions[0]?.question).toBe("string");
  expect(ASK_INPUT_SINGLE.questions[0]?.multiSelect).toBe(false);
  expect(ASK_INPUT_MULTI.questions[0]?.multiSelect).toBe(true);
  expect(ASK_INPUT_SINGLE.questions[0]?.options.length).toBeGreaterThanOrEqual(2);
});

test("the answer reached the model (when the spike passed)", () => {
  if (SPIKE.askViaCanUseTool) {
    expect(ASK_RESULT_TEXT).toContain("Blue");
    expect(ASK_RESULT_MULTI_TEXT).toContain("Red, Blue");
    expect(ASK_RESULT_FREE_TEXT).toContain("Green please");
  }
});

test("thinking and task_started follow SPIKE", () => {
  if (SPIKE.thinking === "block") {
    const t = (ASSISTANT_THINKING as Any).message.content[0];
    expect(t.type).toBe("thinking");
  }
  expect(typeof (TASK_STARTED as Any).tool_use_id === "string").toBe(SPIKE.taskStartedHasToolUseId);
});
