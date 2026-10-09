import { expect, test } from "bun:test";
import { guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { captureLogs } from "../src/observability/logger";
import { RunRecorder } from "../src/observability/record-run";
import { buildToolHooks } from "../src/observability/tool-hooks";
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
    taskId: "t",
    threadId: "th",
    guard: guardFor("qa", { readPaths: ["/ws/repo"] }),
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
