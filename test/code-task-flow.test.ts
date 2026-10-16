import { expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  BRIEF,
  clearWorkspaces,
  DEV_REQUEST,
  defaultLocationPath,
  makeEnv,
  promptText,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";
import { devLeadQuery, noticeSink, workersDone } from "./lead-harness";

/** Env with one workspace `real` whose location/ is a real git clone (a managed clone). */
async function setup(meta: Record<string, unknown> = {}) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(
    env.home,
    "real",
    { description: "test location", gitAuthor: "Test User <test@example.com>", ...meta },
    { path: clone },
  );
  await g(env.home, "clone", "-q", src.location, clone);
  await g(clone, "config", "user.email", "test@example.com");
  await g(clone, "config", "user.name", "t");
  return { env, clone };
}

/**
 * Fake SDK: a worker call (it has the `worker` server) writes and commits b.txt in its cwd and reports; a lead call
 * (the announce after the worker ended) just answers. `seen` records the worker calls only.
 */
function fakeSdk(seen: any[], hold?: Promise<void>) {
  return (a: any) => {
    const o = a.options;
    const worker = !!o.mcpServers?.worker;
    if (worker) seen.push(a);
    return (async function* () {
      if (!worker) {
        yield resultMsg({ result: "noted" });
        return;
      }
      // the worker streams its input: read the first message while the run is live (as the SDK does)
      a.promptText = await promptText(a.prompt);
      await hold;
      writeFileSync(join(o.cwd, "b.txt"), "two\n");
      await g(o.cwd, "add", "b.txt");
      await g(
        o.cwd,
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=t",
        "commit",
        "-qm",
        "add b",
      );
      yield resultMsg({ result: "Done, added b.txt", session_id: "sess-exec" });
    })();
  };
}

/** Handler over the fake SDK plus a sender of owner messages (a dev tag starts the worker, detached). */
function build(env: ReturnType<typeof makeEnv>, queryFn: unknown) {
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: devLeadQuery(queryFn),
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
  });
  return async (text: string, extra: object = {}) => {
    const sink = noticeSink();
    const out = await handle({
      source: "t",
      language: "en" as const,
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "th1",
      text,
      notify: sink.notify,
      ...extra,
    });
    return out ?? sink.first(); // the lead queue answers, with the start notice
  };
}

test("dev task: ONE detached run in the location's own checkout, bypass permissions, memory + worker tools, the commit lands in the checkout", async () => {
  const { env, clone } = await setup();
  const seen: any[] = [];
  const send = build(env, fakeSdk(seen));
  const reply = await send(DEV_REQUEST);
  expect(reply).toBeDefined(); // the fixed start notice; the worker's own text is never returned
  await workersDone(env.db);
  expect(seen).toHaveLength(1);
  const o = seen[0].options;
  expect(o.cwd).toBe(realpathSync(clone)); // no clone, no worktree: the location itself
  expect(o.permissionMode).toBe("default"); // a worker is never auto-approved: canUseTool + the guard hook are the gate
  expect(o.allowDangerouslySkipPermissions).toBeUndefined();
  expect(o.resume).toBeUndefined();
  expect(o.tools).toContain(ASK_USER_QUESTION_TOOL_NAME);
  expect(o.tools).not.toContain("ExitPlanMode");
  expect(Object.keys(o.mcpServers)).toContain("worker");
  expect(Object.keys(o.mcpServers)).not.toContain("git"); // git and gh run in the agent's shell
  expect(env.db.query("SELECT role, location FROM turns WHERE role = 'developer'").get()).toEqual({
    role: "developer",
    location: "real",
  });
  expect(await g(clone, "log", "-1", "--format=%s")).toBe("add b");
});

test("the worker prompt is the owner brief; the handler returns at once and never echoes the brief", async () => {
  const { env } = await setup();
  const seen: any[] = [];
  const send = build(env, fakeSdk(seen));
  const reply = await send(DEV_REQUEST);
  await workersDone(env.db);
  expect(seen[0].promptText).toContain(BRIEF);
  expect(reply).not.toContain("Add b.txt containing two");
});

test("location.yaml gitAuthor / githubAccount are accepted and ignored: a location without a commit identity still runs", async () => {
  const { env, clone } = await setup();
  addLocation(env.home, "real", { githubAccount: "someone-else" }, { path: clone }); // no gitAuthor, an unused account
  const seen: any[] = [];
  const send = build(env, fakeSdk(seen));
  await send("please change x");
  await workersDone(env.db);
  expect(seen).toHaveLength(1);
  expect(seen[0].options.cwd).toBe(realpathSync(clone));
});

test("stop during the dev run cancels the dev task", async () => {
  const { env } = await setup();
  let release!: () => void;
  const started = new Promise<void>((r) => {
    release = r;
  });
  const send = build(env, ((a: any) =>
    (async function* () {
      if (!a.options.mcpServers?.worker) {
        yield resultMsg({ result: "noted" });
        return;
      }
      release(); // the run is going: wait for the abort like a real run would
      await new Promise((_, rej) => {
        a.options.abortController.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    })()) as never);
  await send(DEV_REQUEST);
  await started;
  expect(await send("stop")).toBe("I’m stopping the current work.");
  await workersDone(env.db);
  expect(env.db.query("SELECT type, status FROM turns WHERE role = 'developer'").all()).toEqual([
    { type: "code", status: "cancelled" },
  ]);
});
