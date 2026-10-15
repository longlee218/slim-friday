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
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { openDb } from "../src/storage/db";
import { insertTurn } from "../src/storage/run-store";
import { BASH_TOOL_NAME, GLOB_TOOL_NAME, READ_TOOL_NAME } from "../src/tools/sdk-tool-names";
import {
  addLocation,
  initMsg,
  makeEnv,
  readLogLines,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";
import { workersDone } from "./lead-harness";

/** A `[dev]` message: starts a detached dev worker (the only run a plain handler call makes without the lead). */
const task = (text: string, threadId: string) => ({
  source: "test",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId,
  text: `[dev] ${text}`,
});
/** Handler over a fake query; the worker runs detached, so tests wait with `workersDone`. */
const devHandler = (env: ReturnType<typeof makeEnv>, queryFn: unknown) =>
  createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    limiter: createRunLimiter(10),
    queryFn: queryFn as never,
  });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("a line from a module logger deep in a worker run carries sessionKey/threadId/location/mode", async () => {
  const env = makeEnv();
  const cap = captureLogs();
  const handle = devHandler(env, () =>
    (async function* () {
      yield initMsg;
      yield resultMsg();
    })(),
  );
  await handle(task("location:location what is alpha", "th1"));
  await workersDone(env.db);
  cap.stop();
  const started = cap.lines.find((l) => l.event === "run.started")!;
  expect(started).toMatchObject({ threadId: "th1", location: "location", mode: "dev" });
  expect(started.sessionKey).toMatch(/^task:.+:dev$/);
  // Every run line has the same ids, none passed by hand.
  for (const l of cap.lines.filter((l) => String(l.event).startsWith("run."))) {
    expect(l.sessionKey).toBe(started.sessionKey);
    expect(l.traceId).toBe(started.traceId);
  }
});

test("explicit fields on a call win over the context, and the context is not polluted", () => {
  const cap = captureLogs();
  runWithLogContext({ taskId: "T", location: "a" }, () => {
    logEvent(logger, "x", { location: "b" });
    expect(getLogContext()).toEqual({ taskId: "T", location: "a" });
    setLogContext({ mode: "plan" });
    logEvent(logger, "y");
  });
  cap.stop();
  expect(cap.lines[0]).toMatchObject({ taskId: "T", location: "b" });
  expect(cap.lines[1]).toMatchObject({ taskId: "T", location: "a", mode: "plan" });
  expect(getLogContext()).toEqual({});
});

test("context survives into SDK callbacks (hooks, timers): tool lines carry the session of the worker", async () => {
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
          tool_input: { file_path: join(env.home, "secret.txt") }, // AGENT_HOME is denied to every run
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
      yield resultMsg();
    })();
  await devHandler(env, queryFn)(task("q", "th1"));
  await workersDone(env.db);
  cap.stop();
  // The guard-denied Read logs tool.denied (+ tool.start from the recording hook if it ran); the Glob logs tool.done.
  const calls = cap.lines.filter((l) => l.event === "tool.done" || l.event === "tool.denied");
  expect(calls.map((c) => c.event).sort()).toEqual(["tool.denied", "tool.done"]);
  const started = cap.lines.find((l) => l.event === "task.started")!;
  expect(started.type).toBe("dev"); // the log type is the role name
  const sessionKey = cap.lines.find((l) => l.event === "run.started")!.sessionKey;
  for (const c of calls) expect(c).toMatchObject({ sessionKey, threadId: "th1", mode: "dev" });
  expect(calls.find((c) => c.event === "tool.denied")!.reason).toBeTruthy();
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
  const handle = devHandler(env, queryFn);
  await Promise.all([handle(task("a", "th1")), handle(task("b", "th2"))]);
  await workersDone(env.db);
  cap.stop();
  const byThread = (t: string) =>
    new Set(cap.lines.filter((l) => l.threadId === t && l.sessionKey).map((l) => l.sessionKey));
  expect(byThread("th1").size).toBe(1);
  expect(byThread("th2").size).toBe(1);
  expect([...byThread("th1")][0]).not.toBe([...byThread("th2")][0]);
  expect(cap.lines.filter((l) => l.event === "run.finished").length).toBe(2);
});

test("approval decided by a click outside the task context still logs the task's ids", async () => {
  const db = openDb(":memory:");
  insertTurn(db, { id: "t1", threadId: "th", source: "discord", location: "r", role: "lead" });
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
    gw.request({ turnId: "t1", threadId: "th", tool: BASH_TOOL_NAME, summary: "ls" }),
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

test("context fields (workspace, location) land on every line of the single app log; no per-location copy", async () => {
  const env = makeEnv();
  addLocation(env.home, "api");
  const paths = workspacePaths(env.home);
  const stream = rollingFile(paths.appLog());
  const log = createLogger(stream);
  runWithLogContext({ taskId: "T", workspace: "main", location: "api" }, () =>
    logEvent(log, "ctx.location"),
  );
  logEvent(log, "no.ctx");
  await stream.ready();
  const lines = readLogLines(paths.appLog());
  expect(lines.map((l) => l.event)).toEqual(["ctx.location", "no.ctx"]);
  expect(lines[0]).toMatchObject({ taskId: "T", workspace: "main", location: "api" });
  expect(existsSync(join(paths.workspace("main").root, "logs"))).toBe(false);
  stream.end();
});

/** Run an unpinned dev task whose fake query Reads `file` (when given); returns the captured lines. */
async function runUnpinned(env: ReturnType<typeof makeEnv>, file?: string) {
  const cap = captureLogs();
  const handle = devHandler(env, (a: any) =>
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
    })(),
  );
  await handle(task("hi there", "th-unpinned"));
  await workersDone(env.db);
  cap.stop();
  return cap.lines;
}

test("one workspace with one location: unpinned worker lines carry the location", async () => {
  const env = makeEnv(); // single workspace "main", location "location"
  const lines = await runUnpinned(env);
  for (const e of ["run.started", "task.finished"])
    expect(lines.find((l) => l.event === e)).toMatchObject({
      workspace: "main",
      location: "location",
    });
});

test("two locations, unpinned: a Read inside bbb moves tool.done and later lines to location bbb", async () => {
  const env = makeEnv();
  addLocation(env.home, "aaa");
  const b = addLocation(env.home, "bbb");
  writeFileSync(join(b, "f.txt"), "x");
  const lines = await runUnpinned(env, join(b, "f.txt"));
  expect(lines.find((l) => l.event === "run.started")).toMatchObject({ location: "*" });
  expect(lines.find((l) => l.event === "tool.done")).toMatchObject({ location: "bbb" });
  expect(lines.find((l) => l.event === "task.finished")).toMatchObject({ location: "bbb" });
});

test("a tool call outside every location keeps location *", async () => {
  const env = makeEnv();
  addLocation(env.home, "aaa");
  const lines = await runUnpinned(env, "/etc/hosts");
  expect(lines.find((l) => l.event === "tool.done")).toMatchObject({ location: "*" });
  expect(lines.find((l) => l.event === "task.finished")).toMatchObject({ location: "*" });
});
