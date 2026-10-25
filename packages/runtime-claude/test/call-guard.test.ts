import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec, RuntimeEvent } from "@friday/core";
import { ClaudeRuntime } from "../src/claude-runtime";
import { buildOptions } from "../src/session/build-options";
import { capStopText, createCallGuard, loopStopText } from "../src/session/call-guard";
import { fakeQuery } from "./fake-query";

test("the 6th identical call in a row is denied and stops the run", () => {
  const g = createCallGuard({ maxToolCallsPerTurn: 0 });
  for (let i = 0; i < 5; i++) expect(g.check("Read", { file_path: "/a" })).toEqual({ ok: true });
  expect(g.check("Read", { file_path: "/a" })).toEqual({
    ok: false,
    reason: loopStopText("Read", 6),
    stop: true,
  });
});

test("key order does not matter; a different input resets the streak", () => {
  const g = createCallGuard({ maxToolCallsPerTurn: 0 });
  for (let i = 0; i < 5; i++) g.check("Grep", { pattern: "x", path: "/a" });
  expect(g.check("Grep", { pattern: "y", path: "/a" }).ok).toBe(true);
  for (let i = 0; i < 4; i++) expect(g.check("Grep", { path: "/a", pattern: "y" }).ok).toBe(true);
  expect(g.check("Grep", { path: "/a", pattern: "y" }).ok).toBe(false);
});

test("cap 3 denies the 4th call of a turn; resetTurn starts a new count", () => {
  const g = createCallGuard({ maxToolCallsPerTurn: 3 });
  for (let i = 0; i < 3; i++) expect(g.check("Read", { n: i }).ok).toBe(true);
  expect(g.check("Read", { n: 9 })).toEqual({ ok: false, reason: capStopText(3), stop: true });
  g.resetTurn();
  expect(g.check("Read", { n: 10 }).ok).toBe(true);
});

test("cap 0 never denies", () => {
  const g = createCallGuard({ maxToolCallsPerTurn: 0 });
  for (let i = 0; i < 500; i++) expect(g.check("Read", { n: i }).ok).toBe(true);
});

test("a subagent's calls have their own streak and do not count toward the turn's cap", () => {
  const g = createCallGuard({ maxToolCallsPerTurn: 2 });
  for (let i = 0; i < 5; i++) g.check("Read", { file_path: "/a" }, "sub1");
  expect(g.check("Read", { file_path: "/a" }).ok).toBe(true);
  expect(g.check("Read", { file_path: "/b" }).ok).toBe(true);
  expect(g.check("Read", { file_path: "/a" }, "sub1").ok).toBe(false);
});

const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-")));
const home = join(base, "home");
const scratch = join(home, "runs", "b1");
mkdirSync(scratch, { recursive: true });
const bot: Bot = {
  id: "b1",
  name: "Ann",
  title: "",
  instructions: "",
  model: "sonnet",
  tools: ["Read"],
  skills: [],
  subagents: [],
  workspaces: [],
};
const spec: BotRuntimeSpec = { bot, runKind: "owner", decide: async () => ({ behavior: "allow" }) };

test("the PreToolUse hook denies a guard stop with continue false and reports it", async () => {
  const stops: string[] = [];
  const o = buildOptions({
    spec,
    config: { agentHome: home, scratchRoot: join(home, "runs") },
    abort: new AbortController(),
    scratchDir: scratch,
    guard: createCallGuard({ maxToolCallsPerTurn: 1 }),
    onGuardStop: (t) => stops.push(t),
  });
  const hook = o.hooks?.PreToolUse?.[0]?.hooks[0];
  const call = (file: string) =>
    hook?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: join(scratch, file) },
        tool_use_id: "t1",
      } as never,
      "t1",
      { signal: new AbortController().signal },
    );
  expect(await call("a.ts")).toEqual({ continue: true });
  expect(await call("b.ts")).toEqual({
    continue: false,
    stopReason: capStopText(1),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: capStopText(1),
    },
  });
  expect(stops).toEqual([capStopText(1)]);
  // The floor still denies first, whatever the guard says.
  const floor = await call("../../../.env");
  expect(floor).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});

test("a session ends its events with guard_stop when the guard stops; a new turn resets the cap", async () => {
  const fq = fakeQuery();
  const rt = new ClaudeRuntime({
    agentHome: home,
    scratchRoot: join(home, "runs"),
    queryFn: fq.queryFn,
  });
  const s = await rt.open({ ...spec, maxToolCallsPerTurn: 1 });
  const hook = fq.options().hooks?.PreToolUse?.[0]?.hooks[0];
  const call = (n: number) =>
    hook?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `echo ${n}` },
        tool_use_id: `t${n}`,
      } as never,
      `t${n}`,
      { signal: new AbortController().signal },
    );
  expect(await call(1)).toEqual({ continue: true });
  s.send({
    conversationId: "c1",
    from: { kind: "system" },
    text: "go on",
    hop: 0,
    context: [],
    now: 0,
    timeZone: "UTC",
  });
  expect(await call(2)).toEqual({ continue: true });
  expect(await call(3)).toMatchObject({ continue: false });
  const events: RuntimeEvent[] = [];
  for await (const e of s.events) events.push(e);
  expect(events).toEqual([{ type: "guard_stop", text: capStopText(1) }]);
});
