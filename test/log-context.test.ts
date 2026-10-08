import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Interaction } from "discord.js";
import { createDiscordApprovalGateway } from "../src/approvals/discord-approval";
import { workspacePaths } from "../src/config/workspace-paths";
import { rollingFile } from "../src/observability/log-files";
import {
  captureLogs,
  createLogger,
  getLogContext,
  logEvent,
  logger,
  runWithLogContext,
  setLogContext,
} from "../src/observability/logger";
import { openDb } from "../src/storage/db";
import { insertTask } from "../src/storage/run-store";
import { createTaskHandler } from "../src/tasks/handle-task";
import {
  BASH_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  READ_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { addRepo, initMsg, makeEnv, readLogLines, resultMsg } from "./helpers";

const task = (text: string, threadId: string) => ({ source: "test", userId: "u", threadId, text });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("a line from a module logger deep in a task carries taskId/threadId/repo/mode", async () => {
  const env = makeEnv();
  const cap = captureLogs();
  const handle = createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: (() =>
      (async function* () {
        yield initMsg;
        yield resultMsg();
      })()) as never,
  });
  await handle(task("repo:repo what is alpha", "th1"));
  cap.stop();
  const started = cap.lines.find((l) => l.event === "run.started")!;
  expect(started).toMatchObject({ threadId: "th1", repo: "repo", mode: "qa" });
  expect(typeof started.taskId).toBe("string");
  // Every task line has the same ids, none passed by hand.
  for (const l of cap.lines.filter((l) => String(l.event).startsWith("run."))) {
    expect(l.taskId).toBe(started.taskId);
  }
});

test("explicit fields on a call win over the context, and the context is not polluted", () => {
  const cap = captureLogs();
  runWithLogContext({ taskId: "T", repo: "a" }, () => {
    logEvent(logger, "x", { repo: "b" });
    expect(getLogContext()).toEqual({ taskId: "T", repo: "a" });
    setLogContext({ mode: "plan" });
    logEvent(logger, "y");
  });
  cap.stop();
  expect(cap.lines[0]).toMatchObject({ taskId: "T", repo: "b" });
  expect(cap.lines[1]).toMatchObject({ taskId: "T", repo: "a", mode: "plan" });
  expect(getLogContext()).toEqual({});
});

test("context survives into SDK callbacks (hooks, timers): tool.call lines carry the taskId", async () => {
  const env = makeEnv();
  const cap = captureLogs();
  const queryFn = (a: any) =>
    (async function* () {
      yield initMsg;
      // Callbacks fired from a timer, like the SDK calling back later.
      await tick();
      const pre = a.options.hooks.PreToolUse[0].hooks[0];
      await pre(
        {
          hook_event_name: "PreToolUse",
          tool_use_id: "u1",
          tool_name: READ_TOOL_NAME,
          tool_input: { file_path: "/etc/passwd" },
        },
        "u1",
        { signal: new AbortController().signal },
      );
      const post = a.options.hooks.PostToolUse[0].hooks[0];
      await post(
        {
          hook_event_name: "PostToolUse",
          tool_use_id: "u2",
          tool_name: GLOB_TOOL_NAME,
          tool_input: {},
          tool_response: "ok",
          duration_ms: 1,
        },
        "u2",
        { signal: new AbortController().signal },
      );
      await a.options.canUseTool(EXIT_PLAN_MODE_TOOL_NAME, {}, {});
      yield resultMsg();
    })();
  await createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never })(
    task("q", "th1"),
  );
  cap.stop();
  const calls = cap.lines.filter((l) => l.event === "tool.call");
  expect(calls.length).toBe(2);
  const taskId = cap.lines.find((l) => l.event === "task.started")!.taskId;
  for (const c of calls) expect(c).toMatchObject({ taskId, threadId: "th1", mode: "qa" });
  expect(calls[0]!.decision).toBe("deny");
});

test("two concurrent tasks do not mix contexts", async () => {
  const env = makeEnv();
  const cap = captureLogs();
  let arrived = 0;
  let go!: () => void;
  const barrier = new Promise<void>((r) => (go = r));
  const queryFn = () =>
    (async function* () {
      if (++arrived === 2) go();
      await barrier; // both runs are inside their context at the same time
      await tick();
      yield resultMsg();
    })();
  const handle = createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never });
  await Promise.all([handle(task("a", "th1")), handle(task("b", "th2"))]);
  cap.stop();
  const byThread = (t: string) =>
    new Set(cap.lines.filter((l) => l.threadId === t && l.taskId).map((l) => l.taskId));
  expect(byThread("th1").size).toBe(1);
  expect(byThread("th2").size).toBe(1);
  expect([...byThread("th1")][0]).not.toBe([...byThread("th2")][0]);
  expect(cap.lines.filter((l) => l.event === "run.finished").length).toBe(2);
});

test("approval decided by a click outside the task context still logs the task's ids", async () => {
  const db = openDb(":memory:");
  insertTask(db, { id: "t1", threadId: "th", source: "discord", repo: "r", type: "qa" });
  const sent: any[] = [];
  const channel = {
    isSendable: () => true,
    send: async (p: any) => (sent.push(p), { edit: async () => undefined }),
  };
  const gw = createDiscordApprovalGateway({
    getClient: () => ({ channels: { fetch: async () => channel } }) as never,
    ownerId: "o",
    db,
  });
  const cap = captureLogs();
  // Requested inside a task context ...
  const p = runWithLogContext({ taskId: "t1", threadId: "th", mode: "exec" }, () =>
    gw.request({ taskId: "t1", threadId: "th", tool: BASH_TOOL_NAME, summary: "ls" }),
  );
  await tick();
  // ... clicked from the top level (discord.js event context: no store).
  const id = sent[0].components[0].toJSON().components[0].custom_id;
  const click = {
    isButton: () => true,
    customId: id,
    user: { id: "o" },
    update: async () => undefined,
  };
  await gw.handleInteraction(click as unknown as Interaction);
  await p;
  cap.stop();
  expect(getLogContext()).toEqual({});
  const decided = cap.lines.find((l) => l.event === "approval.decided")!;
  expect(decided).toMatchObject({
    taskId: "t1",
    threadId: "th",
    decision: "approved",
    tool: BASH_TOOL_NAME,
  });
});

test("context fields (workspace, repo) land on every line of the single app log; no per-repo copy", async () => {
  const env = makeEnv();
  addRepo(env.home, "api");
  const paths = workspacePaths(env.home);
  const stream = rollingFile(paths.appLog());
  const log = createLogger(stream);
  runWithLogContext({ taskId: "T", workspace: "main", repo: "api" }, () =>
    logEvent(log, "ctx.repo"),
  );
  logEvent(log, "no.ctx");
  await stream.ready();
  const lines = readLogLines(paths.appLog());
  expect(lines.map((l) => l.event)).toEqual(["ctx.repo", "no.ctx"]);
  expect(lines[0]).toMatchObject({ taskId: "T", workspace: "main", repo: "api" });
  expect(existsSync(join(paths.workspace("main").root, "logs"))).toBe(false);
  stream.end();
});

/** Run an unpinned Q&A whose fake query Reads `file` (when given); returns the captured lines. */
async function runUnpinned(env: ReturnType<typeof makeEnv>, file?: string) {
  const cap = captureLogs();
  const handle = createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: ((a: any) =>
      (async function* () {
        yield initMsg;
        if (file) {
          const input = {
            hook_event_name: "PostToolUse",
            tool_use_id: "r1",
            tool_name: READ_TOOL_NAME,
          };
          const opts = { signal: new AbortController().signal };
          await a.options.hooks.PostToolUse[0].hooks[0](
            { ...input, tool_input: { file_path: file }, tool_response: "x" },
            "r1",
            opts,
          );
        }
        yield resultMsg();
      })()) as never,
  });
  await handle(task("hi there", "th-unpinned"));
  cap.stop();
  return cap.lines;
}

test("one workspace with one repo: unpinned Q&A lines carry workspace and repo", async () => {
  const env = makeEnv(); // single workspace "main", repo "repo"
  const lines = await runUnpinned(env);
  for (const e of ["task.started", "run.started", "task.finished"])
    expect(lines.find((l) => l.event === e)).toMatchObject({ workspace: "main", repo: "repo" });
});

test("two repos, unpinned: a Read inside bbb moves tool.call and later lines to repo bbb", async () => {
  const env = makeEnv();
  addRepo(env.home, "aaa");
  const b = addRepo(env.home, "bbb");
  writeFileSync(join(b, "f.txt"), "x");
  const lines = await runUnpinned(env, join(b, "f.txt"));
  expect(lines.find((l) => l.event === "run.started")).toMatchObject({
    workspace: "main",
    repo: "*",
  });
  expect(lines.find((l) => l.event === "tool.call")).toMatchObject({ repo: "bbb" });
  expect(lines.find((l) => l.event === "task.finished")).toMatchObject({
    workspace: "main",
    repo: "bbb",
  });
});

test("a tool call outside every repo keeps repo *", async () => {
  const env = makeEnv();
  addRepo(env.home, "aaa");
  const lines = await runUnpinned(env, "/etc/hosts");
  expect(lines.find((l) => l.event === "tool.call")).toMatchObject({ repo: "*" });
  expect(lines.find((l) => l.event === "task.finished")).toMatchObject({ repo: "*" });
});
