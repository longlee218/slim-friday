import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { guardFor } from "../src/guardrails/check-tool-call";
import { createGitMcp } from "../src/mcp/git-mcp";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { getRole } from "../src/roles/role-registry";
import { newAskLimit } from "../src/runtime/ask-limit";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import { getSession } from "../src/storage/session-store";
import { getWorktreeByThread } from "../src/storage/worktree-store";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { setupWorkflow } from "./code-flow-fixture";
import { devIntent, initMsg, promptText, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";

/** Ask cap of the dev role (the engine passes it to the guard; direct permission layers below get it explicitly). */
const MAX_ASK = getRole("dev").maxAsk;

/** The real git MCP server (pinned package), shared by the tests of this file. */
const git = createGitMcp();
afterAll(() => git.close());

/** One batched AskUserQuestion input. */
const QUESTIONS = {
  questions: [
    { question: "Drop the column?", options: [{ label: "keep (default)" }, { label: "drop" }] },
  ],
};

/** Stage fake: asks once through canUseTool; a deny aborts like the real SDK does when the flow aborts. */
const askAndMaybeStop = async (o: any) => {
  const r = await o.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {});
  if (o.abortController.signal.aborted) throw new Error("process aborted");
  return r;
};

test("guard: AskUserQuestion calls beyond the cap are denied and never reach the owner", async () => {
  const asked: string[] = [];
  const perms = buildToolPermissions({
    askLimit: newAskLimit(MAX_ASK),
    turnId: "t",
    threadId: "th",
    guard: guardFor("exec", { writePaths: [], readPaths: [], allowedCommands: [] }),
    gateway: stubGateway({
      askChoice: async (a) => {
        asked.push(a.question);
        return a.options[0];
      },
    }),
  });
  for (let n = 0; n < MAX_ASK; n++) {
    const r = await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {} as never);
    expect(r).toMatchObject({ behavior: "allow" });
  }
  const over = await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {} as never);
  expect(over).toMatchObject({ behavior: "deny" });
  expect((over as { message: string }).message).toContain("Already asked");
  expect((over as { message: string }).message).toContain("use the defaults");
  expect(asked).toHaveLength(MAX_ASK);
});

test("the ask budget is shared across stages: spent in plan, denied in exec", async () => {
  const { env } = await setupWorkflow();
  const asked: string[] = [];
  const exec: any[] = [];
  const next = (a: any) =>
    (async function* () {
      const o = a.options;
      yield initMsg;
      if (o.permissionMode === "plan") {
        for (let n = 0; n < MAX_ASK; n++)
          exec.push(await o.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {}));
        const p = await o.canUseTool(EXIT_PLAN_MODE_TOOL_NAME, { plan: "repo: real\nx" }, {});
        if (p.behavior === "allow") throw new Error("process aborted");
        return;
      }
      exec.push(await o.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {}));
      yield resultMsg({ result: "done" });
    })();
  const handle = createTurnHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway({
      askChoice: async (a) => {
        asked.push(a.question);
        return a.options[0];
      },
      confirm: async () => ({ approved: false, reason: "no" }),
    }),
    queryFn: next as never,
    intent: devIntent(env.home),
  });
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] change the schema",
  });
  const last = exec.length - 1;
  expect(exec).toHaveLength(MAX_ASK + 1);
  for (const r of exec.slice(0, last)) expect(r).toMatchObject({ behavior: "allow" }); // plan stage: the budget
  expect(exec[last]).toMatchObject({ behavior: "deny" }); // exec stage: refused
  expect(asked).toHaveLength(MAX_ASK);
});

test("exec: no answer in time -> 'Awaiting clarification', session kept, task cancelled", async () => {
  const { env } = await setupWorkflow();
  const next = (a: any) =>
    (async function* () {
      const o = a.options;
      yield { ...initMsg, session_id: o.permissionMode === "plan" ? "sess-plan" : "sess-exec" };
      if (o.permissionMode === "plan") {
        const p = await o.canUseTool(EXIT_PLAN_MODE_TOOL_NAME, { plan: "repo: real\nx" }, {});
        if (p.behavior === "allow") throw new Error("process aborted");
        return;
      }
      await askAndMaybeStop(o);
      yield resultMsg({ result: "must not be reached" });
    })();
  const handle = createTurnHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway({ askChoice: async () => undefined }), // owner never answers
    queryFn: next as never,
    intent: devIntent(env.home),
  });
  const reply = await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] change it",
    notify: async () => {},
  });
  expect(reply.startsWith("Awaiting clarification:")).toBe(true);
  expect(reply).toContain("Drop the column? (default: keep)");
  expect(reply).toContain("Reply in this thread to continue.");
  const wt = getWorktreeByThread(env.db, "th1")!;
  expect(getSession(env.db, "th1")).toMatchObject({ session_id: "sess-exec", repo: "real" });
  expect(getSession(env.db, "th1")!.cwd).toBe(realpathSync(wt.path));
  expect(env.db.query("SELECT status FROM turns WHERE type = 'code'").all()).toEqual([
    { status: "cancelled" },
  ]);
});

test("plan stage: no answer in time -> 'Awaiting clarification', no plan approval, no worktree", async () => {
  const { env } = await setupWorkflow();
  let planCalls = 0;
  const next = (a: any) =>
    (async function* () {
      planCalls++;
      yield initMsg;
      await askAndMaybeStop(a.options);
      yield resultMsg({ result: "must not be reached" });
    })();
  const handle = createTurnHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway({ askChoice: async () => undefined }),
    queryFn: next as never,
    intent: devIntent(env.home),
  });
  const reply = await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] change it",
    notify: async () => {},
  });
  expect(reply.startsWith("Awaiting clarification:")).toBe(true);
  expect(planCalls).toBe(1); // the exec stage never started
  expect(getWorktreeByThread(env.db, "th1")).toBeNull();
});

/** Handler whose stage fakes run `stage(options, runIndex)`; the owner answers via `askChoice`. */
function handlerWith(
  env: Awaited<ReturnType<typeof setupWorkflow>>["env"],
  askChoice: (a: any) => Promise<string | undefined>,
  stage: (o: any, call: number) => AsyncGenerator<any>,
) {
  let call = 0;
  const handle = createTurnHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway({ askChoice }),
    queryFn: (a: any) => stage(a.options, call++) as never,
    intent: devIntent(env.home),
  });
  return handle;
}

/** Plan stage that approves the plan (the flow moves on to exec), exec stage runs `body`. */
const planThen = (o: any, body: () => Promise<void>) =>
  (async function* () {
    yield { ...initMsg, session_id: o.permissionMode === "plan" ? "sess-plan" : "sess-exec" };
    if (o.permissionMode === "plan") {
      const p = await o.canUseTool(EXIT_PLAN_MODE_TOOL_NAME, { plan: "repo: real\nx" }, {});
      if (p.behavior === "allow") throw new Error("process aborted");
      return;
    }
    await body();
    yield resultMsg({ result: "must not be reached" });
  })();

test("stop while a question is pending (plan): not 'Awaiting clarification', session not kept", async () => {
  const { env } = await setupWorkflow();
  const handle: ReturnType<typeof handlerWith> = handlerWith(
    env,
    async () => {
      handle.abortAll(); // what `stop` does: the pending ask is cancelled (resolves undefined)
      return undefined;
    },
    (o) =>
      (async function* () {
        yield initMsg;
        await askAndMaybeStop(o);
        yield resultMsg({ result: "must not be reached" });
      })(),
  );
  const reply = await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] please start",
  });
  expect(reply.startsWith("Awaiting clarification")).toBe(false);
  // No plan/exec session kept for the cancelled stage (and no assistant turn before the dev task).
  expect(getSession(env.db, "th1")).toBeNull();
});

test("stop while a question is pending (exec): not 'Awaiting clarification', session not kept", async () => {
  const { env } = await setupWorkflow();
  const handle: ReturnType<typeof handlerWith> = handlerWith(
    env,
    async () => {
      handle.abortAll();
      return undefined;
    },
    (o) => planThen(o, () => askAndMaybeStop(o)),
  );
  const reply = await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] please start",
  });
  expect(reply.startsWith("Awaiting clarification")).toBe(false);
  // No plan/exec session kept for the cancelled stage (and no assistant turn before the dev task).
  expect(getSession(env.db, "th1")).toBeNull();
});

test("one AskUserQuestion call with 2 questions: both reach the owner, all answered, one call of the budget used", async () => {
  const asked: string[] = [];
  const perms = buildToolPermissions({
    askLimit: newAskLimit(MAX_ASK),
    turnId: "t",
    threadId: "th",
    guard: guardFor("exec", { writePaths: [], readPaths: [], allowedCommands: [] }),
    gateway: stubGateway({
      askChoice: async (a) => {
        asked.push(a.question);
        return a.options[1];
      },
    }),
  });
  const two = {
    questions: [
      { question: "Q1?", options: [{ label: "a (default)" }, { label: "b" }] },
      { question: "Q2?", options: [{ label: "c (default)" }, { label: "d" }] },
    ],
  };
  const r = await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, two, {} as never);
  expect(r).toMatchObject({
    behavior: "allow",
    updatedInput: { answers: { "Q1?": "b", "Q2?": "d" } },
  });
  expect(asked).toEqual(["Q1?", "Q2?"]);
  for (let n = 1; n < MAX_ASK; n++)
    expect(await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, two, {} as never)).toMatchObject({
      behavior: "allow",
    });
  const again = await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, two, {} as never);
  expect(again).toMatchObject({ behavior: "deny" });
});

test("two concurrent tasks have independent ask limits", async () => {
  const { env } = await setupWorkflow();
  let waiting = 0;
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  const results: string[] = [];
  const handle = handlerWith(
    env,
    // Each ask waits until both tasks are asking at once, then answers the default.
    async (a) => {
      if (++waiting === 2) release();
      await both;
      return a.options[0];
    },
    (o) =>
      (async function* () {
        yield initMsg;
        results.push((await o.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {})).behavior);
        yield resultMsg({ result: "plan done" });
      })(),
  );
  await Promise.all([
    handle({
      source: "t",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "th1",
      text: "[dev] one",
    }),
    handle({
      source: "t",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "th2",
      text: "[dev] two",
    }),
  ]);
  expect(results).toEqual(["allow", "allow"]); // a shared limit would deny the second
});

test("resume after 'Awaiting clarification': the owner's reply resumes the exec session in the worktree", async () => {
  const { env } = await setupWorkflow();
  const execRuns: { resume?: string; cwd: string; prompt: string; second?: string }[] = [];
  let ask = 0;
  const handle = createTurnHandler({
    git,
    db: env.db,
    config: env.config,
    // First ask: owner silent (timeout). After the reply: the owner answers the next ask.
    approvals: stubGateway({ askChoice: async (a) => (++ask === 1 ? undefined : a.options[0]) }),
    queryFn: ((a: any) => {
      const o = a.options;
      if (o.permissionMode === "plan" || !execRuns.length) {
        return planThen(o, async () => {
          execRuns.push({ cwd: o.cwd, prompt: await promptText(a.prompt) });
          await askAndMaybeStop(o);
        });
      }
      return (async function* () {
        yield { ...initMsg, session_id: "sess-exec" };
        // Current behavior (kept): a resumed reply is a fresh flow with a fresh limit, so the owner
        // can be asked a second round after having answered.
        const r = await o.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {});
        execRuns.push({
          resume: o.resume,
          cwd: o.cwd,
          prompt: await promptText(a.prompt),
          second: r.behavior,
        });
        yield resultMsg({ result: "continued", session_id: "sess-exec" });
      })();
    }) as never,
    intent: devIntent(env.home),
  });
  const first = await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] please start",
    notify: async () => {},
  });
  expect(first.startsWith("Awaiting clarification")).toBe(true);
  const wt = getWorktreeByThread(env.db, "th1")!;
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] keep the column",
    notify: async () => {},
  });
  const resumed = execRuns[1]!;
  expect(resumed).toMatchObject({
    resume: "sess-exec",
    cwd: realpathSync(wt.path),
    prompt: "[dev] keep the column",
    second: "allow",
  });
});
