import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalGateway, ApprovalRequest } from "../src/approvals/approval-types";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { parseTaskCommand, RESUME_PROMPT } from "../src/orchestrator/task-commands";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import {
  addRepo,
  clearWorkspaces,
  DEV_REQUEST,
  devIntent,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

/** Fake gateway: records requests and answers with a scripted decision. */
function fakeGateway(approved = true) {
  const asked: { kind: string; req: ApprovalRequest }[] = [];
  const gw = stubGateway({
    request: async (req) => {
      asked.push({ kind: "request", req });
      return approved ? { approved } : { approved, reason: "no" };
    },
    requestPlan: async (req) => {
      asked.push({ kind: "plan", req });
      return approved ? { approved } : { approved, reason: "owner rejected plan" };
    },
    askChoice: async (a) => a.options[0],
  });
  return { gw, asked };
}

/**
 * Run one `[dev]` message (the intent layer opens a dev task); capture the SDK options of the plan stage.
 * Without `gw` the approval flow is off (nothing runs).
 */
async function runCodeTask(gw?: ApprovalGateway) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const repo = addRepo(env.home, "repo"); // managed clone (code tasks need one)
  let opts: any;
  const qa: any[] = []; // every run
  const query = (a: any) => {
    opts = a.options;
    qa.push(a.options);
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: query as never,
    approvals: gw,
    intent: devIntent(env.home),
  });
  const reply = await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "t1",
    text: DEV_REQUEST,
  });
  return { env, opts, reply, repo, qa };
}

test("parseTaskCommand: stop, cleanup and repo: hint; task: is plain Q&A text", () => {
  expect(parseTaskCommand(" Stop ")).toEqual({ kind: "stop" });
  expect(parseTaskCommand("stop it")).toMatchObject({ kind: "task" });
  expect(parseTaskCommand("cleanup:")).toEqual({ kind: "cleanup", taskId: undefined });
  expect(parseTaskCommand("CLEANUP: abc")).toEqual({ kind: "cleanup", taskId: "abc" });
  expect(parseTaskCommand("task: add a file")).toEqual({
    kind: "task",
    repo: undefined,
    text: "task: add a file",
  });
  expect(parseTaskCommand("what is x?")).toEqual({
    kind: "task",
    repo: undefined,
    text: "what is x?",
  });
  expect(parseTaskCommand("repo:api how does auth work?")).toEqual({
    kind: "task",
    repo: "api",
    text: "how does auth work?",
  });
  expect(parseTaskCommand("task: repo:api fix it")).toEqual({
    kind: "task",
    repo: undefined,
    text: "task: repo:api fix it",
  });
});

test("parseTaskCommand: go, go +<usd>; invalid raises are plain messages; Resume prompt unchanged", () => {
  expect(parseTaskCommand("go")).toEqual({ kind: "go" });
  expect(parseTaskCommand(" GO ")).toEqual({ kind: "go" });
  expect(parseTaskCommand("go +1.5")).toEqual({ kind: "go", extraBudgetUsd: 1.5 });
  expect(parseTaskCommand("go +2")).toEqual({ kind: "go", extraBudgetUsd: 2 });
  for (const bad of [
    "go +0",
    `go +${"9".repeat(400)}`,
    "go +1000.5",
    "go -1",
    "go +abc",
    "go 1.5",
    "go +1.5 now",
    "go ahead",
    "go+1",
  ])
    expect(parseTaskCommand(bad)).toMatchObject({ kind: "task", text: bad });
  expect(parseTaskCommand(RESUME_PROMPT)).toEqual({ kind: "resume" });
});

test("without approvals no run starts: the owner is told code tasks need the approval flow", async () => {
  const { qa, reply } = await runCodeTask();
  expect(qa).toHaveLength(0);
  expect(reply).toContain("approval flow");
});

test("code task runs in plan mode in the scratch dir with write tools and no allowedTools", async () => {
  const { gw } = fakeGateway();
  const { env, opts, repo, qa } = await runCodeTask(gw);
  expect(qa).toHaveLength(1); // the plan stage only: no assistant turn before it
  expect(opts.permissionMode).toBe("plan");
  expect(opts.tools).toContain(WRITE_TOOL_NAME);
  expect(opts.allowedTools).toBeUndefined(); // would bypass canUseTool
  expect(opts.cwd).toContain(join(realpathSync(env.home), "workspaces", "main", "tasks"));
  expect(opts.additionalDirectories).toEqual([realpathSync(repo)]);
  expect(opts.canUseTool).toBeFunction();
  expect(opts.systemPrompt.append).toContain("plan mode");
  // The plan stage keeps its session on the task row, never in the thread's session table.
  expect(env.db.query("SELECT cwd FROM sessions").all()).toEqual([]);
  expect(env.db.query("SELECT type FROM tasks").all()).toEqual([{ type: "code" }]);
});

test("canUseTool: plan goes to owner; writes only in scratch; risky Bash asks; denial reaches agent", async () => {
  const { gw, asked } = fakeGateway();
  const { opts } = await runCodeTask(gw);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;

  expect((await can(EXIT_PLAN_MODE_TOOL_NAME, { plan: "repo: repo\nstep 1" }, {})).behavior).toBe(
    "allow",
  );
  expect(asked[0]).toMatchObject({ kind: "plan", req: { detail: "repo: repo\nstep 1" } });

  expect(
    (await can(WRITE_TOOL_NAME, { file_path: join(opts.cwd, "a.txt"), content: "x" }, {})).behavior,
  ).toBe("allow");
  expect(
    (await can(WRITE_TOOL_NAME, { file_path: "/etc/passwd", content: "x" }, {})).behavior,
  ).toBe("deny");
  expect((await can(BASH_TOOL_NAME, { command: "rm -rf /tmp/x" }, {})).behavior).toBe("deny");
  expect(asked).toHaveLength(1); // allow/deny decisions never bother the owner

  expect((await can(BASH_TOOL_NAME, { command: "bun add left-pad" }, {})).behavior).toBe("allow");
  expect(asked[1]).toMatchObject({ kind: "request", req: { tool: BASH_TOOL_NAME } });

  const ans = await can(
    ASK_USER_QUESTION_TOOL_NAME,
    { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] },
    {},
  );
  expect(ans.updatedInput.answers).toEqual({ "Q?": "A" });
});

test("owner rejection becomes a deny message the agent can act on", async () => {
  const { gw } = fakeGateway(false);
  const { opts } = await runCodeTask(gw);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  const plan = await can(EXIT_PLAN_MODE_TOOL_NAME, { plan: "repo: repo\np" }, {});
  expect(plan.behavior).toBe("deny");
  expect(plan.message).toContain("rejected the plan");
  const bash = await can(BASH_TOOL_NAME, { command: "bun add x" }, {});
  expect(bash).toMatchObject({ behavior: "deny" });
});

test("PreToolUse hook denies dangerous Bash and forces ask for unknown Bash", async () => {
  const { gw } = fakeGateway();
  const { opts } = await runCodeTask(gw);
  const hook = opts.hooks.PreToolUse[0].hooks[0] as (i: any) => Promise<any>;
  const call = (command: string) =>
    hook({ hook_event_name: "PreToolUse", tool_name: BASH_TOOL_NAME, tool_input: { command } });
  expect((await call("sudo ls")).hookSpecificOutput.permissionDecision).toBe("deny");
  expect((await call("ls -la")).hookSpecificOutput.permissionDecision).toBe("ask");
  expect(await call("git status")).toEqual({ continue: true });
});
