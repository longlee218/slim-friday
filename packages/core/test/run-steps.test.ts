import { expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

/** A hub with editor's direct session open and a turn running. */
async function open() {
  const h = makeHub();
  await h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const s = h.runtime.nth(0);
  return { ...h, s };
}
const states = (r: { step: { kind: string; state: string } }[]) =>
  r.map((x) => [x.step.kind, x.step.state]);

test("thinking, tool call, result, then text stores the steps with the message", async () => {
  const { s, surface, store } = await open();
  s.emit({ type: "thinking" });
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: { file_path: "/a" } });
  s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
  s.emit({ type: "text", text: "done" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(states(surface.runs)).toEqual([
    ["thinking", "running"],
    ["thinking", "done"],
    ["tool", "running"],
    ["tool", "done"],
  ]);
  expect(store.msgs.at(-1)?.run?.map((x) => x.id)).toEqual(["think-1", "t1"]);
});

test("a failed tool result marks the step failed", async () => {
  const { s, surface } = await open();
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Bash", input: { command: "x" } });
  s.emit({ type: "tool_result", toolUseId: "t1", ok: false });
  await flush();
  expect(surface.runs.at(-1)?.step).toMatchObject({ id: "t1", state: "failed" });
});

test("a second answer carries only the steps after the first; narration is a step of the next answer", async () => {
  const { s, store } = await open();
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: {} });
  s.emit({ type: "text", text: "one" });
  s.emit({ type: "text", text: "two" });
  s.emit({ type: "tool_call", toolUseId: "t2", tool: "Read", input: {} });
  s.emit({ type: "text", text: "three" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  const bots = store.msgs.filter((m) => m.author.kind === "bot");
  expect(bots.map((m) => m.text)).toEqual(["one", "three"]);
  expect(bots.map((m) => m.run?.map((x) => x.id))).toEqual([["t1"], ["note-1", "t2"]]);
  expect(bots[1]?.run?.[0]).toMatchObject({ label: "Note", target: "two" });
});

test("text without steps stores no run; unknown tool_result changes nothing", async () => {
  const { s, store, surface } = await open();
  s.emit({ type: "tool_result", toolUseId: "nope", ok: true });
  s.emit({ type: "text", text: "plain" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(surface.runs).toEqual([]);
  expect(store.msgs.at(-1)?.run).toBeUndefined();
});

test("turn_end closes an open thinking step", async () => {
  const { s, surface } = await open();
  s.emit({ type: "thinking" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(states(surface.runs)).toEqual([
    ["thinking", "running"],
    ["thinking", "done"],
  ]);
});

test("background task start and end are subagent steps", async () => {
  const { s, surface } = await open();
  s.emit({ type: "task_started", taskId: "k1", description: "scan repo" });
  s.emit({ type: "task_done", taskId: "k1", status: "failed", summary: "" });
  await flush();
  expect(surface.runs.map((r) => [r.step.kind, r.step.state, r.step.target])).toEqual([
    ["subagent", "running", "scan repo"],
    ["subagent", "failed", "scan repo"],
  ]);
});

test("task_started reuses the Agent tool step instead of adding a second one", async () => {
  const { s, surface, store } = await open();
  s.emit({ type: "tool_call", toolUseId: "a1", tool: "Agent", input: { description: "d" } });
  s.emit({ type: "task_started", taskId: "k1", description: "scan repo", toolUseId: "a1" });
  s.emit({ type: "task_done", taskId: "k1", status: "completed", summary: "" });
  s.emit({ type: "text", text: "x" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(new Set(surface.runs.map((r) => r.step.id))).toEqual(new Set(["a1"]));
  expect(store.msgs.at(-1)?.run).toHaveLength(1);
  expect(store.msgs.at(-1)?.run?.[0]).toMatchObject({ target: "scan repo", state: "done" });
});

test("with parallel Agent calls, task_started maps to the step of its tool use id", async () => {
  const { s, surface } = await open();
  s.emit({ type: "tool_call", toolUseId: "a1", tool: "Agent", input: { description: "one" } });
  s.emit({ type: "tool_call", toolUseId: "a2", tool: "Agent", input: { description: "two" } });
  s.emit({ type: "task_started", taskId: "k2", description: "second", toolUseId: "a2" });
  s.emit({ type: "task_done", taskId: "k2", status: "completed", summary: "" });
  await flush();
  const last = surface.runs.at(-1)?.step;
  expect(last).toMatchObject({ id: "a2", state: "done", target: "second" });
  expect(surface.runs.some((r) => r.step.id === "a1" && r.step.state === "done")).toBe(false);
});
