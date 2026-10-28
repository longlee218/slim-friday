import { expect, test } from "bun:test";
import type { Grant, ToolCall, ToolSpec } from "../src";
import { decide } from "../src/permission/decide";

const TOOL = "mcp__computer__ComputerClick";
const call: ToolCall = { botId: "b1", conversationId: "c", tool: TOOL, input: {} };
const IN_COMPUTER: ToolSpec = { name: TOOL, annotations: {}, inComputer: true };
const require: Grant = {
  id: "r1",
  botId: "*",
  effect: "require_approval",
  match: "tool",
  tool: TOOL,
  scope: {},
  createdAt: 0,
};
const run = (spec: ToolSpec | undefined, extra: Partial<Parameters<typeof decide>[0]> = {}) =>
  decide({
    call,
    spec,
    grants: [require],
    settings: { level: "careful" },
    now: 100,
    taint: { reason: "x", mandatory: true },
    ...extra,
  });

test("a computer tool is allowed over level, taint and a require rule", () => {
  expect(run(IN_COMPUTER)).toEqual({ outcome: "allow", reason: "inside the bot's computer" });
});

test("the floor and a per-tool deny still win over inComputer", () => {
  expect(run(IN_COMPUTER, { floorDenyReason: "floor" })).toEqual({
    outcome: "deny",
    reason: "floor",
  });
  const denied = run(IN_COMPUTER, { settings: { level: "careful", tools: { [TOOL]: "deny" } } });
  expect(denied.outcome).toBe("deny");
});

test("inComputer false or absent behaves as before", () => {
  for (const spec of [
    { ...IN_COMPUTER, inComputer: false },
    { name: TOOL, annotations: {} },
  ]) {
    const d = run(spec);
    expect(d.outcome).toBe("ask_always");
    expect(d.reason).toContain("tainted");
  }
  expect(run(undefined, { taint: undefined, grants: [] }).outcome).toBe("ask");
});
