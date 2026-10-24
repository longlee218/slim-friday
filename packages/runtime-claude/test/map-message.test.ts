import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mapMessage } from "../src/session/map-message";
import {
  ASSISTANT_SUBAGENT_TOOL_USE,
  ASSISTANT_THINKING,
  ASSISTANT_TOOL_USE,
  SPIKE,
  USER_TOOL_RESULT_ERROR,
  USER_TOOL_RESULT_OK,
} from "./fixtures/sdk-shapes";

const m = (x: unknown) => mapMessage(x as SDKMessage);
const assistant = (content: unknown[], parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content },
});

test("assistant text becomes one text event, blocks joined", () => {
  expect(
    m(
      assistant([
        { type: "text", text: " a " },
        { type: "text", text: "b" },
      ]),
    ),
  ).toEqual([{ type: "text", text: "a\nb" }]);
});

test("an empty assistant message has no event", () => {
  expect(m(assistant([{ type: "text", text: "  " }]))).toEqual([]);
});

test("a subagent's own text is not the bot's text", () => {
  expect(m(assistant([{ type: "text", text: "inner" }], "toolu_1"))).toEqual([]);
});

test("task_started and task_notification map to task events", () => {
  expect(
    m({ type: "system", subtype: "task_started", task_id: "t1", description: "read" }),
  ).toEqual([{ type: "task_started", taskId: "t1", description: "read" }]);
  for (const status of ["completed", "failed", "stopped"] as const)
    expect(
      m({ type: "system", subtype: "task_notification", task_id: "t1", status, summary: "s" }),
    ).toEqual([{ type: "task_done", taskId: "t1", status, summary: "s" }]);
});

test("a success result ends the turn with its cost", () => {
  expect(m({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.02 })).toEqual([
    { type: "turn_end", costUsd: 0.02 },
  ]);
});

test("max turns still ends the turn", () => {
  expect(
    m({
      type: "result",
      subtype: "error_max_turns",
      is_error: false,
      total_cost_usd: 0.5,
      errors: [],
    }),
  ).toEqual([{ type: "turn_end", costUsd: 0.5 }]);
});

test("an error result is an error event, never a turn end", () => {
  const e = m({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["API Error: 529 overloaded"],
    total_cost_usd: 0,
  });
  expect(e).toEqual([{ type: "error", message: "API Error: 529 overloaded", retryable: true }]);
  const real = m({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["bad request"],
    total_cost_usd: 0,
  });
  expect(real).toEqual([{ type: "error", message: "bad request", retryable: false }]);
  const ok = m({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "model refused",
    total_cost_usd: 0,
  });
  expect(ok).toEqual([{ type: "error", message: "model refused", retryable: false }]);
});

test("a sandbox that cannot start is a non-retryable SANDBOX_UNAVAILABLE", () => {
  const e = m({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["sandbox-exec failed to start"],
    total_cost_usd: 0,
  });
  expect(e).toEqual([
    {
      type: "error",
      message: "SANDBOX_UNAVAILABLE: sandbox-exec failed to start",
      retryable: false,
    },
  ]);
});

test("other messages map to nothing", () => {
  expect(m({ type: "system", subtype: "init", session_id: "s" })).toEqual([]);
  expect(m({ type: "stream_event" })).toEqual([]);
});

test("a compaction boundary is a compacted event", () => {
  expect(
    mapMessage({ type: "system", subtype: "compact_boundary", compact_metadata: {} } as never),
  ).toEqual([{ type: "compacted" }]);
});

test("main-thread tool_use and tool_result become tool events", () => {
  expect(mapMessage(ASSISTANT_TOOL_USE)).toContainEqual({
    type: "tool_call",
    toolUseId: expect.any(String),
    tool: "Read",
    input: expect.any(Object),
  });
  expect(mapMessage(USER_TOOL_RESULT_ERROR)).toEqual([
    { type: "tool_result", toolUseId: expect.any(String), ok: false },
  ]);
  expect(mapMessage(USER_TOOL_RESULT_OK)).toEqual([
    { type: "tool_result", toolUseId: expect.any(String), ok: true },
  ]);
  expect(mapMessage(ASSISTANT_SUBAGENT_TOOL_USE)).toEqual([]);
  expect(
    m({
      type: "user",
      parent_tool_use_id: "t",
      message: { content: [{ type: "tool_result", tool_use_id: "x" }] },
    }),
  ).toEqual([]);
  expect(m({ type: "user", parent_tool_use_id: null, message: { content: "plain" } })).toEqual([]);
});

test("thinking is presence only, once per message", () => {
  const ev = mapMessage(ASSISTANT_THINKING);
  if (SPIKE.thinking === "none") expect(ev.some((e) => e.type === "thinking")).toBe(false);
  else expect(ev).toContainEqual({ type: "thinking" });
  const two = m(
    assistant([
      { type: "thinking", thinking: "secret" },
      { type: "redacted_thinking" },
      { type: "text", text: "hi" },
    ]),
  );
  expect(two).toEqual([{ type: "thinking" }, { type: "text", text: "hi" }]);
  expect(JSON.stringify(two)).not.toContain("secret");
});

test("events keep block order: thinking, tool calls, then the joined text", () => {
  const ev = m(
    assistant([
      { type: "thinking" },
      { type: "tool_use", id: "a", name: "Read", input: {} },
      { type: "text", text: "x" },
    ]),
  );
  expect(ev.map((e) => e.type)).toEqual(["thinking", "tool_call", "text"]);
});
