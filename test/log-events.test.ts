import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runAgent } from "../src/agent/run-agent";
import { workspacePaths } from "../src/config/workspace-paths";
import { routedStream } from "../src/observability/log-files";
import {
  captureLogs,
  createLogger,
  excerpt,
  logEvent,
  runWithLogContext,
} from "../src/observability/logger";
import { RunRecorder } from "../src/observability/record-run";
import { buildToolHooks } from "../src/observability/tool-hooks";
import { addWorkspace, fakeQuery, initMsg, makeEnv, readLogLines, resultMsg } from "./helpers";

/** A logger whose lines are collected as parsed objects. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ write: (l: string) => lines.push(JSON.parse(l)) });
  return { log, lines };
}

test("logEvent writes a stable event field (also the message) plus fields", () => {
  const { log, lines } = capture();
  logEvent(log.child({ taskId: "T", threadId: "th" }), "task.started", { repo: "api", type: "qa" });
  expect(lines[0]).toMatchObject({
    event: "task.started",
    msg: "task.started",
    level: 30,
    taskId: "T",
    threadId: "th",
    repo: "api",
    type: "qa",
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
  const stream = routedStream(env.home);
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

test("lines with a registered repo go to both files; others only to the main file", async () => {
  const env = makeEnv();
  addWorkspace(env.home, "api");
  const paths = workspacePaths(env.home);
  const stream = routedStream(env.home);
  const log = createLogger(stream);
  logEvent(log, "a.with_repo", { repo: "api" });
  logEvent(log, "b.star", { repo: "*" });
  logEvent(log, "c.unregistered", { repo: "ghost" });
  logEvent(log, "d.traversal", { repo: "../x" });
  logEvent(log, "e.no_repo");
  logEvent(log.child({ repo: "api" }), "f.bound_repo");
  await stream.ready();
  const names = (base: string) => readLogLines(base).map((l) => l.event);
  expect(names(paths.appLog())).toEqual([
    "a.with_repo",
    "b.star",
    "c.unregistered",
    "d.traversal",
    "e.no_repo",
    "f.bound_repo",
  ]);
  expect(names(paths.appLog("api"))).toEqual(["a.with_repo", "f.bound_repo"]);
  // The unregistered repo got no workspace dir created by logging.
  expect(readLogLines(paths.appLog("ghost"))).toEqual([]);
  stream.end();
});

test("rolled file name has the date and the .jsonl extension", async () => {
  const env = makeEnv();
  const stream = routedStream(env.home);
  createLogger(stream).info("x");
  await stream.ready();
  const day = new Date().toLocaleDateString("sv"); // yyyy-MM-dd, local time like pino-roll
  const { rolledFiles } = await import("./helpers");
  expect(rolledFiles(workspacePaths(env.home).appLog())[0]).toMatch(
    new RegExp(`app\\.${day}\\.\\d+\\.jsonl$`),
  );
  stream.end();
});

test("tool.call line has guard decision, duration, error flag and a redacted input", async () => {
  const env = makeEnv();
  const { lines, stop } = captureLogs();
  const rec = new RunRecorder(env.db, "r1", "t1", "m", env.paths.taskLog("t1"));
  const decisions = new Map([["u1", { decision: "ask" as const, reason: "git commit" }]]);
  const hook = buildToolHooks(rec, decisions).PostToolUse![0]!.hooks[0]!;
  await hook(
    {
      hook_event_name: "PostToolUse",
      tool_use_id: "u1",
      tool_name: "Bash",
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
    event: "tool.call",
    tool: "Bash",
    decision: "ask",
    reason: "git commit",
    durationMs: 7,
    isError: false,
  });
  expect(String(lines[0]?.input)).not.toContain("hunter2");
});

test("a run logs run.started and run.finished with the task's correlation fields", async () => {
  const env = makeEnv();
  const { lines, stop } = captureLogs();
  await runWithLogContext({ taskId: "T1", threadId: "th1", repo: "repo", mode: "qa" }, () =>
    runAgent({
      prompt: "q",
      taskId: "T1",
      logRepo: "repo",
      cwd: env.home,
      config: env.config,
      db: env.db,
      abortController: new AbortController(),
      queryFn: fakeQuery([initMsg, resultMsg()]),
    }),
  );
  stop();
  const events = lines.map((l) => l.event);
  expect(events).toEqual(["run.started", "run.finished"]);
  expect(lines[0]).toMatchObject({
    taskId: "T1",
    threadId: "th1",
    repo: "repo",
    mode: "qa",
    resume: false,
  });
  expect(lines[1]).toMatchObject({
    outcome: "success",
    turns: 2,
    inputTokens: 10,
    costUsd: 0.0012,
  });
  // Raw per-task stream is untouched by event logging.
  expect(readFileSync(env.paths.taskLog("T1", "repo"), "utf8")).toContain("sdk message");
});
