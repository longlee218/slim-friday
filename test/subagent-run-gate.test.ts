import { expect, test } from "bun:test";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { MAX_PARALLEL_SUBAGENTS, MAX_SUBAGENT_SPAWNS } from "../src/guardrails/subagent-run";
import { captureLogs } from "../src/observability/logger";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import {
  AGENT_TOOL_NAME,
  READ_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { exec, POST_AGENT, SEND_IN, SIG, SPAWN_IN, spawn, WT } from "./subagent-spawn-helper";

// Stateful run gate (hook level): unique names, 2 in flight, 41st start or resume, SendMessage targets, logs.

/** Run hooks of one run with real hook-input shapes; the state is the permission layer's (per run). */
function run(guard = exec()) {
  const perms = buildToolPermissions({
    taskId: "t",
    threadId: "th",
    guard,
    bypassMode: { active: true },
  });
  const pre = perms.hooks[0]!.hooks[0]!;
  const post = perms.postHooks.PostToolUse![0]!.hooks[0]!;
  const fail = perms.postHooks.PostToolUseFailure![0]!.hooks[0]!;
  let n = 0;
  const decide = async (tool: string, input: object, agent?: object, id = `u${++n}`) => {
    const out: any = await pre(
      {
        hook_event_name: "PreToolUse",
        tool_use_id: id,
        tool_name: tool,
        tool_input: input,
        ...agent,
      } as never,
      id,
      SIG,
    );
    return {
      denied: out.hookSpecificOutput?.permissionDecision === "deny",
      reason: out.hookSpecificOutput?.permissionDecisionReason as string | undefined,
      id,
    };
  };
  const finished = (id: string, input: object, response: object) =>
    post(
      { ...POST_AGENT, tool_use_id: id, tool_input: input, tool_response: response } as never,
      id,
      SIG,
    );
  const failed = (id: string, input: object) =>
    fail(
      {
        hook_event_name: "PostToolUseFailure",
        tool_use_id: id,
        tool_name: AGENT_TOOL_NAME,
        tool_input: input,
        error: "x",
      } as never,
      id,
      SIG,
    );
  return { decide, finished, failed };
}
const agentIn = (name: string, over: object = {}) => ({
  ...SPAWN_IN,
  subagent_type: "implementer",
  name,
  ...over,
});

test("hook: a duplicate name in one run is denied, a new run starts clean", async () => {
  const r = run();
  const a = await r.decide(AGENT_TOOL_NAME, agentIn("impl-1"));
  expect(a.denied).toBe(false);
  await r.finished(a.id, agentIn("impl-1"), { ...POST_AGENT.tool_response, agentId: "ag1" });
  const dup = await r.decide(AGENT_TOOL_NAME, agentIn("impl-1"));
  expect(dup.denied).toBe(true);
  expect(dup.reason).toContain("already used");
  expect((await run().decide(AGENT_TOOL_NAME, agentIn("impl-1"))).denied).toBe(false); // reset per run
});

test("hook: at most 2 subagents in flight; Post and PostFailure free a slot", async () => {
  expect(MAX_PARALLEL_SUBAGENTS).toBe(2);
  const r = run();
  const a = await r.decide(AGENT_TOOL_NAME, agentIn("a"));
  const b = await r.decide(AGENT_TOOL_NAME, agentIn("b"));
  expect([a.denied, b.denied]).toEqual([false, false]);
  const c = await r.decide(AGENT_TOOL_NAME, agentIn("c"));
  expect(c.denied).toBe(true);
  expect(c.reason).toContain("at most 2");
  await r.finished(a.id, agentIn("a"), POST_AGENT.tool_response);
  expect((await r.decide(AGENT_TOOL_NAME, agentIn("c"))).denied).toBe(false);
  await r.failed(b.id, agentIn("b"));
  expect((await r.decide(AGENT_TOOL_NAME, agentIn("d"))).denied).toBe(false);
});

test("hook: the 41st start or resume is denied (cap is a code constant, spawns and resumes share it)", async () => {
  expect(MAX_SUBAGENT_SPAWNS).toBe(40);
  const r = run();
  const a = await r.decide(AGENT_TOOL_NAME, agentIn("w"));
  await r.finished(a.id, agentIn("w"), POST_AGENT.tool_response);
  for (let i = 1; i < MAX_SUBAGENT_SPAWNS; i++)
    expect((await r.decide(SEND_MESSAGE_TOOL_NAME, { ...SEND_IN, to: "w" })).denied).toBe(false);
  const over = await r.decide(SEND_MESSAGE_TOOL_NAME, { ...SEND_IN, to: "w" });
  expect(over.denied).toBe(true);
  expect(over.reason).toContain("limit reached");
  expect((await r.decide(AGENT_TOOL_NAME, agentIn("z"))).denied).toBe(true);
});

test("hook: SendMessage targets: own name and own agentId pass; unknown, missing, foreign ids and broadcast are denied", async () => {
  const r = run();
  const a = await r.decide(AGENT_TOOL_NAME, agentIn("worker"));
  // Before the Post hook only the name is known (the agentId arrives with the response).
  expect((await r.decide(SEND_MESSAGE_TOOL_NAME, SEND_IN)).denied).toBe(false); // recorded input: to = worker
  expect(
    (await r.decide(SEND_MESSAGE_TOOL_NAME, { ...SEND_IN, to: POST_AGENT.tool_response.agentId }))
      .denied,
  ).toBe(true);
  await r.finished(a.id, agentIn("worker"), POST_AGENT.tool_response);
  expect(
    (await r.decide(SEND_MESSAGE_TOOL_NAME, { ...SEND_IN, to: POST_AGENT.tool_response.agentId }))
      .denied,
  ).toBe(false);
  for (const to of ["nobody", "*", "team-lead", "a982bfd6ad035924e", "", undefined, 5, null]) {
    const d = await r.decide(SEND_MESSAGE_TOOL_NAME, { ...SEND_IN, to });
    expect(d.denied).toBe(true);
  }
  // Structured protocol messages and non-text bodies are denied even for a known target.
  expect(
    (await r.decide(SEND_MESSAGE_TOOL_NAME, { ...SEND_IN, type: "shutdown_request" })).denied,
  ).toBe(true);
  expect(
    (await r.decide(SEND_MESSAGE_TOOL_NAME, { ...SEND_IN, message: { type: "shutdown_request" } }))
      .denied,
  ).toBe(true);
});

test("hook: SendMessage from a subagent is always denied (even to a known name); explorer-only stages cannot resume", async () => {
  const r = run();
  const a = await r.decide(AGENT_TOOL_NAME, agentIn("worker"));
  await r.finished(a.id, agentIn("worker"), POST_AGENT.tool_response);
  const sub = await r.decide(SEND_MESSAGE_TOOL_NAME, SEND_IN, {
    agent_id: "x1",
    agent_type: "implementer",
  });
  expect(sub.denied).toBe(true);
  expect(sub.reason).toContain("may not message");
  const plan = run(guardFor("plan", { readPaths: [WT] }));
  const p = await plan.decide(SEND_MESSAGE_TOOL_NAME, SEND_IN);
  expect(p.denied).toBe(true);
  expect(p.reason).toContain("can be resumed");
});

test("hook: denials are logged with their reason; spawn and resume lines carry model asked/resolved and counts", async () => {
  const cap = captureLogs();
  const r = run();
  const a = await r.decide(AGENT_TOOL_NAME, agentIn("worker"));
  await r.finished(a.id, agentIn("worker"), POST_AGENT.tool_response);
  await r.decide(SEND_MESSAGE_TOOL_NAME, SEND_IN);
  await r.decide(AGENT_TOOL_NAME, agentIn("w2", { model: "opus" }));
  cap.stop();
  const spawned = cap.lines.find((l) => l.event === "subagent.spawned");
  expect(spawned).toMatchObject({
    subagentType: "implementer",
    name: "worker",
    modelAsked: "haiku",
    modelResolved: "claude-haiku-4-5",
    agentId: POST_AGENT.tool_response.agentId,
    spawns: 1,
  });
  expect(cap.lines.find((l) => l.event === "subagent.resume")).toMatchObject({
    to: "worker",
    spawns: 2,
  });
  const denied = cap.lines.find((l) => l.event === "tool.denied");
  expect(denied?.tool).toBe(AGENT_TOOL_NAME);
  expect(String(denied?.reason)).toContain("cap");
});

test("the canUseTool path never double counts: the pure guard is stateless", () => {
  const ctx = exec();
  for (let i = 0; i < 3; i++) expect(spawn({ name: "same" }, ctx).decision).toBe("allow");
  expect(checkToolCall(READ_TOOL_NAME, { file_path: `${WT}/a` }, ctx).decision).toBe("allow");
});

test("hook: a failed spawn releases its name (a retry with the same name is allowed)", async () => {
  const r = run();
  const a = await r.decide(AGENT_TOOL_NAME, agentIn("retry-me"));
  expect((await r.decide(AGENT_TOOL_NAME, agentIn("retry-me"))).denied).toBe(true); // reserved while in flight
  await r.failed(a.id, agentIn("retry-me"));
  expect((await r.decide(AGENT_TOOL_NAME, agentIn("retry-me"))).denied).toBe(false);
});
