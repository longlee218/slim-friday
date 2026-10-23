import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec, InboundTurn, RuntimeEvent } from "@friday/core";
import { ClaudeRuntime } from "../src/claude-runtime";
import { fakeQuery } from "./fake-query";

const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-")));
const bot: Bot = {
  id: "b1",
  name: "Ann",
  title: "Dev",
  instructions: "Be brief.",
  model: "sonnet",
  tools: ["Read"],
  skills: [],
  subagents: [],
  workspaces: [],
};
const spec: BotRuntimeSpec = { bot, decide: async () => ({ behavior: "allow" }) };
const turn = (text: string): InboundTurn => ({
  conversationId: "c1",
  from: { kind: "user" },
  text,
  hop: 0,
  context: [],
});
const setup = () => {
  const fq = fakeQuery();
  const rt = new ClaudeRuntime({
    agentHome: join(root, "home"),
    scratchRoot: join(root, "runs"),
    queryFn: fq.queryFn,
  });
  return { fq, rt };
};
/** First `n` events of a session. */
async function take(events: AsyncIterable<RuntimeEvent>, n: number): Promise<RuntimeEvent[]> {
  const got: RuntimeEvent[] = [];
  if (n === 0) return got;
  for await (const e of events) {
    got.push(e);
    if (got.length === n) break;
  }
  return got;
}
const ok = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 };
const say = (text: string) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "text", text }] },
});
const tick = () => Bun.sleep(5);

test("open returns at once with a new session id that the SDK is told to use", async () => {
  const { fq, rt } = setup();
  const s = await rt.open(spec);
  expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(fq.options().sessionId).toBe(s.id);
  expect(fq.options().resume).toBeUndefined();
});

test("resume passes the stored id as resume", async () => {
  const { fq, rt } = setup();
  const s = await rt.resume("abc", spec);
  expect(s.id).toBe("abc");
  expect(fq.options().resume).toBe("abc");
  expect(fq.options().sessionId).toBeUndefined();
});

test("two sends reach the SDK in order, formatted", async () => {
  const { fq, rt } = setup();
  const s = await rt.open(spec);
  s.send(turn("one"));
  s.send(turn("two"));
  await tick();
  expect(fq.sent()).toEqual([
    "[conversation c1] user (hop 0):\none",
    "[conversation c1] user (hop 0):\ntwo",
  ]);
});

test("text then a success result gives text, turn_end", async () => {
  const { fq, rt } = setup();
  const s = await rt.open(spec);
  fq.emit({ type: "system", subtype: "init", session_id: "x" });
  fq.emit(say("hi"));
  fq.emit(ok);
  expect(await take(s.events, 2)).toEqual([
    { type: "text", text: "hi" },
    { type: "turn_end", costUsd: 0.01 },
  ]);
});

test("input stays open while a background task runs: a second send still arrives", async () => {
  const { fq, rt } = setup();
  const s = await rt.open(spec);
  s.send(turn("one"));
  fq.emit({ type: "system", subtype: "task_started", task_id: "t1", description: "d" });
  expect(await take(s.events, 1)).toEqual([
    { type: "task_started", taskId: "t1", description: "d" },
  ]);
  s.send(turn("two"));
  await tick();
  expect(fq.sent()).toHaveLength(2);
});

test("an error result is an error event and never a turn_end", async () => {
  const { fq, rt } = setup();
  const s = await rt.open(spec);
  fq.emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["bad"],
    total_cost_usd: 0,
  });
  const got = await take(s.events, 1);
  expect(got[0]?.type).toBe("error");
});

test("a stream failure rejects events with that error", async () => {
  const { fq, rt } = setup();
  const s = await rt.open(spec);
  fq.fail(new Error("boom"));
  await expect(take(s.events, 1)).rejects.toThrow("boom");
});

test("stop aborts the SDK, ends the input and events, and a later send is dropped", async () => {
  const { fq, rt } = setup();
  const s = await rt.open(spec);
  const pending = take(s.events, 1);
  await s.stop();
  expect(fq.options().abortController?.signal.aborted).toBe(true);
  expect(await pending).toEqual([]);
  s.send(turn("late"));
  await tick();
  expect(fq.sent()).toEqual([]);
});
