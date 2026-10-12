import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { captureLogs } from "../src/observability/logger";
import { RunRecorder } from "../src/observability/record-run";
import { buildSubagentHooks } from "../src/observability/subagent-hooks";
import { buildToolHooks } from "../src/observability/tool-hooks";
import { getRole } from "../src/roles/role-registry";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import { EDIT_TOOL_NAME, READ_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv } from "./helpers";

/** Invoke the PostToolUse hook with a given tool input. */
async function post(
  db: ReturnType<typeof makeEnv>["db"],
  paths: ReturnType<typeof makeEnv>["paths"],
  input: unknown,
) {
  const rec = new RunRecorder(db, "r1", "t1", "m", paths.taskLog("t1"));
  const hook = buildToolHooks(rec).PostToolUse![0]!.hooks[0]!;
  const out = await hook(
    {
      hook_event_name: "PostToolUse",
      tool_use_id: "u1",
      tool_name: READ_TOOL_NAME,
      tool_input: input,
      tool_response: "ok",
      duration_ms: 3,
    } as never,
    "u1",
    { signal: new AbortController().signal },
  );
  rec.close();
  return out;
}

test("M6: circular tool input is stored, hook does not throw", async () => {
  const { db, paths } = makeEnv();
  const a: Record<string, unknown> = {};
  a.self = a;
  expect(await post(db, paths, a)).toEqual({ continue: true });
  expect(
    db.query<{ input_json: string }, []>("SELECT input_json FROM tool_calls").get()?.input_json,
  ).toContain("[Circular]");
});

test("M6: throwing DB never propagates into the SDK", async () => {
  const { db, paths } = makeEnv();
  db.close();
  expect(await post(db, paths, { file_path: "a" })).toEqual({ continue: true });
});

test("tool_calls row has redacted input", async () => {
  const { db, paths } = makeEnv();
  await post(db, paths, { content: "password: hunter2" });
  expect(
    db.query<{ input_json: string }, []>("SELECT input_json FROM tool_calls").get()?.input_json,
  ).not.toContain("hunter2");
});

const SIG = { signal: new AbortController().signal };

test("start/done pair share toolUseId; target is relative; no result text in any line", async () => {
  const { db, paths } = makeEnv();
  const cap = captureLogs();
  const rec = new RunRecorder(db, "r1", "t1", "m", paths.taskLog("t1"));
  const hooks = buildToolHooks(rec, { roots: ["/ws/repo"] });
  const input = { file_path: "/ws/repo/src/a.ts", offset: 70, limit: 90 };
  await hooks.PreToolUse![0]!.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      tool_use_id: "u9",
      tool_name: READ_TOOL_NAME,
      tool_input: input,
    } as never,
    "u9",
    SIG,
  );
  await hooks.PostToolUse![0]!.hooks[0]!(
    {
      hook_event_name: "PostToolUse",
      tool_use_id: "u9",
      tool_name: READ_TOOL_NAME,
      tool_input: input,
      tool_response: { file: { content: "TOP SECRET FILE BODY", numLines: 90 } },
      duration_ms: 2,
    } as never,
    "u9",
    SIG,
  );
  rec.close();
  cap.stop();
  const [start, done] = cap.lines;
  expect(start).toMatchObject({ event: "tool.start", toolUseId: "u9", target: "src/a.ts:70-159" });
  expect(done).toMatchObject({
    event: "tool.done",
    toolUseId: "u9",
    ok: true,
    lines: 90,
    durationMs: 2,
  });
  expect(done!.decision).toBeUndefined(); // default allow is not repeated
  expect(JSON.stringify(cap.lines)).not.toContain("TOP SECRET");
});

test("failed call: tool.done ok=false with a redacted err", async () => {
  const { db, paths } = makeEnv();
  const cap = captureLogs();
  const rec = new RunRecorder(db, "r1", "t1", "m", paths.taskLog("t1"));
  await buildToolHooks(rec).PostToolUseFailure![0]!.hooks[0]!(
    {
      hook_event_name: "PostToolUseFailure",
      tool_use_id: "u2",
      tool_name: READ_TOOL_NAME,
      tool_input: { file_path: "a" },
      error: "ENOENT password: hunter2",
    } as never,
    "u2",
    SIG,
  );
  rec.close();
  cap.stop();
  expect(cap.lines[0]).toMatchObject({ event: "tool.done", ok: false });
  expect(String(cap.lines[0]!.err)).not.toContain("hunter2");
});

test("guard-denied call writes tool.denied (warn) with target and reason, and no tool.done", async () => {
  const cap = captureLogs();
  const perms = buildToolPermissions({
    turnId: "t",
    threadId: "th",
    guard: guardFor(getRole("assistant"), { readPaths: ["/ws/repo"] }),
  });
  await perms.hooks[0]!.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      tool_use_id: "u3",
      tool_name: READ_TOOL_NAME,
      tool_input: { file_path: "/etc/passwd" },
    } as never,
    "u3",
    SIG,
  );
  cap.stop();
  const denied = cap.lines.filter((l) => l.event === "tool.denied");
  expect(denied).toHaveLength(1);
  expect(denied[0]).toMatchObject({ toolUseId: "u3", target: "…/passwd", level: 40 });
  expect(denied[0]!.reason).toBeTruthy();
  expect(cap.lines.some((l) => l.event === "tool.done")).toBe(false);
});

test("parallel tool calls: each toolUseId gets its own start/done pair and duration", async () => {
  const { db, paths } = makeEnv();
  const cap = captureLogs();
  const rec = new RunRecorder(db, "r1", "t1", "m", paths.taskLog("t1"));
  const hooks = buildToolHooks(rec);
  const pre = hooks.PreToolUse![0]!.hooks[0]!;
  const post = hooks.PostToolUse![0]!.hooks[0]!;
  const ev = (name: string, id: string, extra = {}) =>
    ({
      hook_event_name: name,
      tool_use_id: id,
      tool_name: READ_TOOL_NAME,
      tool_input: { file_path: `${id}.ts` },
      ...extra,
    }) as never;
  await pre(ev("PreToolUse", "a"), "a", SIG);
  await pre(ev("PreToolUse", "b"), "b", SIG);
  await post(ev("PostToolUse", "b", { tool_response: "x", duration_ms: 5 }), "b", SIG);
  await post(ev("PostToolUse", "a", { tool_response: "xy", duration_ms: 9 }), "a", SIG);
  rec.close();
  cap.stop();
  const done = cap.lines.filter((l) => l.event === "tool.done");
  expect(done.map((l) => [l.toolUseId, l.target, l.durationMs, l.chars])).toEqual([
    ["b", "b.ts", 5, 1],
    ["a", "a.ts", 9, 2],
  ]);
  expect(cap.lines.filter((l) => l.event === "tool.start").map((l) => l.toolUseId)).toEqual([
    "a",
    "b",
  ]);
});

test("MCP tool (shape: content[] text parts): size from text, target = tool + relative path, no text logged", async () => {
  const { db, paths } = makeEnv();
  const cap = captureLogs();
  const rec = new RunRecorder(db, "r1", "t1", "m", paths.taskLog("t1"));
  const tool = mcpToolName(GIT_MCP_SERVER, GIT_TOOL.LOG);
  await buildToolHooks(rec, { roots: ["/ws/repo"] }).PostToolUse![0]!.hooks[0]!(
    {
      hook_event_name: "PostToolUse",
      tool_use_id: "m1",
      tool_name: tool,
      tool_input: { path: "/ws/repo/lib" },
      tool_response: { content: [{ type: "text", text: "COMMIT LOG TEXT" }] },
      duration_ms: 3,
    } as never,
    "m1",
    SIG,
  );
  rec.close();
  cap.stop();
  expect(cap.lines[0]).toMatchObject({
    event: "tool.done",
    tool,
    target: "git_log lib",
    chars: 15,
  });
  expect(JSON.stringify(cap.lines)).not.toContain("COMMIT LOG TEXT");
});

test("Write/Edit input preview in tool.done has no file content; Edit failure err has no echo", async () => {
  const { db, paths } = makeEnv();
  const cap = captureLogs();
  const rec = new RunRecorder(db, "r1", "t1", "m", paths.taskLog("t1"));
  const input = {
    file_path: "/a.ts",
    old_string: "OLD-SECRET-BODY",
    new_string: "NEW-SECRET-BODY",
  };
  await buildToolHooks(rec).PostToolUseFailure![0]!.hooks[0]!(
    {
      hook_event_name: "PostToolUseFailure",
      tool_use_id: "e1",
      tool_name: EDIT_TOOL_NAME,
      tool_input: input,
      error: "String to replace not found\nString: OLD-SECRET-BODY",
    } as never,
    "e1",
    SIG,
  );
  rec.close();
  cap.stop();
  expect(JSON.stringify(cap.lines)).not.toContain("SECRET-BODY");
  expect(cap.lines[0]!.err).toBe("String to replace not found");
});

/** Real SDK 0.3.295 hook payloads (P3.0 fixtures). */
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures/sdk-hooks", `${name}.json`), "utf8"));

test("P3.1: tool.start/done/denied of a subagent carry agentId/agentType; tool_calls.agent_id is stored; main agent has none", async () => {
  const { db, paths } = makeEnv();
  const cap = captureLogs();
  const rec = new RunRecorder(db, "r1", "t1", "m", paths.taskLog("t1"));
  const hooks = buildToolHooks(rec);
  const pre = fixture("pre-tool-use-subagent-builtin-read");
  const post = fixture("post-tool-use-subagent-read");
  await hooks.PreToolUse![0]!.hooks[0]!(pre, pre.tool_use_id, SIG);
  await hooks.PostToolUse![0]!.hooks[0]!(post, post.tool_use_id, SIG);
  // The main agent's call (the parent's Agent call fixture has no agent_id).
  const main = fixture("pre-tool-use-parent-agent-call");
  await hooks.PreToolUse![0]!.hooks[0]!(main, main.tool_use_id, SIG);
  rec.close();
  cap.stop();
  const [start, done, mainStart] = cap.lines;
  expect(start).toMatchObject({ agentId: "a982bfd6ad035924e", agentType: "limited" });
  expect(done).toMatchObject({ event: "tool.done", agentId: "a982bfd6ad035924e" });
  expect(mainStart).not.toHaveProperty("agentId");
  expect(mainStart).not.toHaveProperty("agentType");
  expect(
    db.query<{ agent_id: string | null }, []>("SELECT agent_id FROM tool_calls").get()?.agent_id,
  ).toBe("a982bfd6ad035924e");
});

test("P3.1: tool.denied of a subagent carries its identity", async () => {
  const cap = captureLogs();
  const perms = buildToolPermissions({
    turnId: "t1",
    threadId: "th",
    guard: guardFor(getRole("assistant"), { readPaths: ["/ws/repo"] }),
  });
  const pre = {
    ...fixture("pre-tool-use-subagent-builtin-read"),
    tool_input: { file_path: "/etc/passwd" },
  };
  const out: any = await perms.hooks[0]!.hooks[0]!(pre, pre.tool_use_id, SIG);
  cap.stop();
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(cap.lines.find((l) => l.event === "tool.denied")).toMatchObject({
    agentId: "a982bfd6ad035924e",
    agentType: "limited",
  });
});

test("P3.1: SubagentStart/Stop log ids, duration and result size only; hooks never block", async () => {
  const cap = captureLogs();
  const hooks = buildSubagentHooks();
  const start = fixture("subagent-start");
  const stop = fixture("subagent-stop");
  const a = await hooks.SubagentStart![0]!.hooks[0]!(start, undefined, SIG);
  const b = await hooks.SubagentStop![0]!.hooks[0]!(stop, undefined, SIG);
  cap.stop();
  expect(a).toEqual({ continue: true });
  expect(b).toEqual({ continue: true });
  const [s, e] = cap.lines;
  expect(s).toMatchObject({
    event: "subagent.start",
    agentId: "a982bfd6ad035924e",
    agentType: "limited",
  });
  expect(e).toMatchObject({
    event: "subagent.stop",
    agentId: "a982bfd6ad035924e",
    agentType: "limited",
    resultChars: stop.last_assistant_message.length,
  });
  expect(typeof e!.durationMs).toBe("number");
  expect(JSON.stringify(cap.lines)).not.toContain("PELICAN"); // the subagent's text is never logged
});

test("P3.1: a throwing logger path never propagates (stop without start)", async () => {
  const hooks = buildSubagentHooks();
  expect(await hooks.SubagentStop![0]!.hooks[0]!(fixture("subagent-stop"), undefined, SIG)).toEqual(
    {
      continue: true,
    },
  );
});
