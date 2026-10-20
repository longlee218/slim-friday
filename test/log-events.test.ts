import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { rollingFile } from "../src/observability/log-files";
import {
  captureLogs,
  createLogger,
  excerpt,
  logEvent,
  runWithLogContext,
} from "../src/observability/logger";
import { RunRecorder } from "../src/observability/record-run";
import { buildToolHooks } from "../src/observability/tool-hooks";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { addLocation, fakeQuery, initMsg, makeEnv, readLogLines, resultMsg } from "./helpers";

/** A logger whose lines are collected as parsed objects. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ write: (l: string) => lines.push(JSON.parse(l)) });
  return { log, lines };
}

test("logEvent writes a stable event field (also the message) plus fields", () => {
  const { log, lines } = capture();
  logEvent(log.child({ taskId: "T", threadId: "th" }), "task.started", {
    location: "api",
    type: "assistant",
  });
  expect(lines[0]).toMatchObject({
    event: "task.started",
    msg: "task.started",
    level: 30,
    taskId: "T",
    threadId: "th",
    location: "api",
    type: "assistant",
  });
});

test("excerpt masks secrets and caps length", () => {
  const key = `sk-ant-${"a".repeat(30)}`;
  const text = excerpt(`use ${key} and ghp_${"b".repeat(30)}\n\nplease`);
  expect(text).not.toContain(key);
  expect(text).not.toContain("ghp_b");
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain("\n");
  expect(excerpt("x".repeat(2000)).length).toBe(500);
});

test("secrets in an event field go through excerpt and never reach the file", async () => {
  const env = makeEnv();
  const stream = rollingFile(workspacePaths(env.home).appLog());
  const log = createLogger(stream);
  logEvent(log, "message.received", {
    text: excerpt(`my OPENROUTER_API_KEY=sk-or-v1-${"c".repeat(30)}`),
  });
  log.info({ token: "tok-123", env: { A: "plain-env" } }, "keyed");
  await stream.ready();
  const raw = readLogLines(workspacePaths(env.home).appLog());
  expect(JSON.stringify(raw)).not.toContain("sk-or-v1-c");
  expect(JSON.stringify(raw)).not.toContain("tok-123");
  expect(JSON.stringify(raw)).not.toContain("plain-env");
  expect(raw[0]?.text).toContain("[REDACTED]");
  stream.end();
});

test("every line goes to the one app log; no per-location log dir is created", async () => {
  const env = makeEnv();
  addLocation(env.home, "api");
  const paths = workspacePaths(env.home);
  const stream = rollingFile(paths.appLog());
  const log = createLogger(stream);
  logEvent(log, "a.with_location", { location: "api", workspace: "main" });
  logEvent(log, "b.star", { location: "*" });
  logEvent(log, "c.no_location");
  await stream.ready();
  const lines = readLogLines(paths.appLog());
  expect(lines.map((l) => l.event)).toEqual(["a.with_location", "b.star", "c.no_location"]);
  expect(lines[0]).toMatchObject({ workspace: "main", location: "api" });
  expect(existsSync(join(paths.workspace("main").root, "logs"))).toBe(false);
  expect(existsSync(join(paths.workspaces, "api"))).toBe(false);
  stream.end();
});

test("rolled file name has the date and the .jsonl extension", async () => {
  const env = makeEnv();
  const stream = rollingFile(workspacePaths(env.home).appLog());
  createLogger(stream).info("x");
  await stream.ready();
  const day = new Date().toLocaleDateString("sv"); // yyyy-MM-dd, local time like pino-roll
  const { rolledFiles } = await import("./helpers");
  expect(rolledFiles(workspacePaths(env.home).appLog())[0]).toMatch(
    new RegExp(`app\\.${day}\\.\\d+\\.jsonl$`),
  );
  stream.end();
});

test("tool.done line has non-default guard decision, duration, ok flag and a redacted input", async () => {
  const env = makeEnv();
  const { lines, stop } = captureLogs();
  const rec = new RunRecorder(env.db, "r1", "t1", "m", env.paths.taskLog("t1"));
  const decisions = new Map([["u1", { decision: "ask" as const, reason: "git commit" }]]);
  const hook = buildToolHooks(rec, { decisions }).PostToolUse![0]!.hooks[0]!;
  await hook(
    {
      hook_event_name: "PostToolUse",
      tool_use_id: "u1",
      tool_name: BASH_TOOL_NAME,
      tool_input: { command: "echo password: hunter2" },
      tool_response: "ok",
      duration_ms: 7,
    } as never,
    "u1",
    { signal: new AbortController().signal },
  );
  rec.close();
  stop();
  expect(lines[0]).toMatchObject({
    event: "tool.done",
    tool: BASH_TOOL_NAME,
    toolUseId: "u1",
    decision: "ask",
    reason: "git commit",
    durationMs: 7,
    ok: true,
  });
  expect(String(lines[0]?.input)).not.toContain("hunter2");
  expect(String(lines[0]?.target)).not.toContain("hunter2");
});

test("a run logs run.started and run.finished with the task's correlation fields", async () => {
  const env = makeEnv();
  const { lines, stop } = captureLogs();
  await runWithLogContext(
    { taskId: "T1", threadId: "th1", location: "location", mode: "assistant" },
    () =>
      runAgent({
        prompt: "q",
        turnId: "T1",
        role: getRole("lead"),
        cwd: env.home,
        config: env.config,
        db: env.db,
        abortController: new AbortController(),
        queryFn: fakeQuery([initMsg, resultMsg()]),
      }),
  );
  stop();
  const events = lines.map((l) => l.event);
  expect(events).toEqual([
    "skills.plugin_built", // the lead loads its method skill and brainstorming (two plugins)
    "skills.plugin_built",
    "run.started",
    "permission.mode",
    "run.finished",
    "skills.used", // the lead logs its skill use too
  ]);
  expect(lines[2]).toMatchObject({
    taskId: "T1",
    threadId: "th1",
    location: "location",
    mode: "assistant",
    resume: false,
  });
  expect(lines[3]).toMatchObject({ event: "permission.mode" });
  expect(lines[4]).toMatchObject({
    outcome: "success",
    turns: 2,
    inputTokens: 10,
    costUsd: 0.0012,
  });
  // Raw per-task stream is untouched by event logging.
  expect(readFileSync(env.paths.taskLog("T1"), "utf8")).toContain("sdk message");
  // The raw task log is plain JSONL: one `msg` (the label) and the SDK message under `sdk`.
  const first = JSON.parse(readFileSync(env.paths.taskLog("T1"), "utf8").split("\n")[0]!);
  expect(first.msg).toBe("sdk message");
  expect(first.sdk.type).toBeDefined();
});
