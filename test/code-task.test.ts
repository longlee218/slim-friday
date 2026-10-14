import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalGateway, ApprovalRequest } from "../src/approvals/approval-types";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { parseMessageCommand, RESUME_PROMPT } from "../src/orchestrator/message-commands";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  SEND_FEEDBACK_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import {
  addLocation,
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
    askChoice: async (a) => (approved ? a.options[0] : undefined), // `approved` false = the owner never answers
  });
  return { gw, asked };
}

/**
 * Run one `[dev]` message (the intent layer opens a dev task); capture the SDK options of its run.
 * Without `gw` the approval flow is off (nothing runs).
 */
async function runCodeTask(gw?: ApprovalGateway) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const location = addLocation(env.home, "location"); // managed clone (code tasks need one)
  let opts: any;
  const qa: any[] = []; // every run
  const query = (a: any) => {
    opts = a.options;
    qa.push(a.options);
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTurnHandler({
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
  return { env, opts, reply, location, qa };
}

test("parseMessageCommand: stop and location: hint; cleanup: is plain text; task: is plain Q&A text", () => {
  expect(parseMessageCommand(" Stop ")).toEqual({ kind: "stop" });
  expect(parseMessageCommand("stop it")).toMatchObject({ kind: "message" });
  expect(parseMessageCommand("cleanup:")).toMatchObject({ kind: "message" });
  expect(parseMessageCommand("task: add a file")).toEqual({
    kind: "message",
    location: undefined,
    text: "task: add a file",
  });
  expect(parseMessageCommand("what is x?")).toEqual({
    kind: "message",
    location: undefined,
    text: "what is x?",
  });
  expect(parseMessageCommand("location:api how does auth work?")).toEqual({
    kind: "message",
    location: "api",
    text: "how does auth work?",
  });
  expect(parseMessageCommand("task: location:api fix it")).toEqual({
    kind: "message",
    location: undefined,
    text: "task: location:api fix it",
  });
});

test("parseMessageCommand: go, go +<usd>; invalid raises are plain messages; Resume prompt unchanged", () => {
  expect(parseMessageCommand("go")).toEqual({ kind: "go" });
  expect(parseMessageCommand(" GO ")).toEqual({ kind: "go" });
  expect(parseMessageCommand("go +1.5")).toEqual({ kind: "go", extraBudgetUsd: 1.5 });
  expect(parseMessageCommand("go +2")).toEqual({ kind: "go", extraBudgetUsd: 2 });
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
    expect(parseMessageCommand(bad)).toMatchObject({ kind: "message", text: bad });
  expect(parseMessageCommand(RESUME_PROMPT)).toEqual({ kind: "resume" });
});

test("without approvals no run starts: the owner is told code tasks need the approval flow", async () => {
  const { qa, reply } = await runCodeTask();
  expect(qa).toHaveLength(0);
  expect(reply).toContain("approval flow");
});

test("code task runs in bypass mode in the location with write tools and no allowedTools", async () => {
  const { gw } = fakeGateway();
  const { env, opts, location, qa } = await runCodeTask(gw);
  expect(qa).toHaveLength(1); // one run: no assistant turn before it
  expect(opts.permissionMode).toBe("bypassPermissions");
  expect(opts.tools).toContain(WRITE_TOOL_NAME);
  expect(opts.allowedTools).toBeUndefined(); // would bypass canUseTool
  expect(opts.cwd).toBe(realpathSync(location));
  const ws = join(realpathSync(env.home), "workspaces", "main");
  expect(opts.additionalDirectories[0]).toContain(join(ws, "tasks"));
  expect(opts.additionalDirectories[1]).toBe(join(ws, "worktrees"));
  expect(opts.canUseTool).toBeFunction();
  expect(opts.systemPrompt.append).toContain(
    "Do not change files before the owner approved your plan",
  );
  // The run keeps its session on the task row, never in the thread's session table.
  expect(env.db.query("SELECT cwd FROM sessions").all()).toEqual([]);
  expect(env.db.query("SELECT type FROM turns").all()).toEqual([{ type: "code" }]);
});

test("canUseTool: writes only in the workspace; a feedback report asks; the plan question goes to the owner", async () => {
  const { gw, asked } = fakeGateway();
  const { opts } = await runCodeTask(gw);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;

  expect(
    (await can(WRITE_TOOL_NAME, { file_path: join(opts.cwd, "a.txt"), content: "x" }, {})).behavior,
  ).toBe("allow");
  expect(
    (await can(WRITE_TOOL_NAME, { file_path: "/etc/passwd", content: "x" }, {})).behavior,
  ).toBe("deny");
  expect((await can(BASH_TOOL_NAME, { command: "rm -rf /etc/x" }, {})).behavior).toBe("deny");
  expect(asked).toHaveLength(0); // allow/deny decisions never bother the owner

  // Bash never asks; a tool the owner must decide (SendFeedback) does.
  expect((await can(BASH_TOOL_NAME, { command: "bun add left-pad" }, {})).behavior).toBe("allow");
  expect(asked).toHaveLength(0);
  expect((await can(SEND_FEEDBACK_TOOL_NAME, { type: "bug", title: "t" }, {})).behavior).toBe(
    "allow",
  );
  expect(asked[0]).toMatchObject({ kind: "request", req: { tool: SEND_FEEDBACK_TOOL_NAME } });

  const ans = await can(
    ASK_USER_QUESTION_TOOL_NAME,
    { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] },
    {},
  );
  expect(ans.updatedInput.answers).toEqual({ "Q?": "A" });
});

test("a tool the owner denies, or a question the owner does not answer, becomes a deny message the agent can act on", async () => {
  const { gw } = fakeGateway(false);
  const { opts } = await runCodeTask(gw);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  const plan = await can(
    ASK_USER_QUESTION_TOOL_NAME,
    { questions: [{ question: "Approve the plan?", options: [{ label: "Approve" }] }] },
    {},
  );
  expect(plan.behavior).toBe("deny");
  expect(plan.message).toContain("did not answer");
  const feedback = await can(SEND_FEEDBACK_TOOL_NAME, { type: "bug", title: "t" }, {});
  expect(feedback).toMatchObject({ behavior: "deny" });
});

test("PreToolUse hook denies dangerous Bash and lets other Bash run; in bypass an owner-decided tool is let through (the SDK asks nothing)", async () => {
  const { gw } = fakeGateway();
  const { opts } = await runCodeTask(gw);
  const hook = opts.hooks.PreToolUse[0].hooks[0] as (i: any) => Promise<any>;
  const call = (command: string) =>
    hook({ hook_event_name: "PreToolUse", tool_name: BASH_TOOL_NAME, tool_input: { command } });
  expect((await call("sudo ls")).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(await call("less notes.txt")).toEqual({ continue: true });
  const feedback = await hook({
    hook_event_name: "PreToolUse",
    tool_name: SEND_FEEDBACK_TOOL_NAME,
    tool_input: { type: "bug", title: "t" },
  });
  expect(feedback).toEqual({ continue: true });
  expect(await call("git status")).toEqual({ continue: true });
});

test("parseMessageCommand: the old `repo:` pin still works as an alias of `location:`", () => {
  expect(parseMessageCommand("repo:api fix it")).toMatchObject({ location: "api", text: "fix it" });
  expect(parseMessageCommand("location:api fix it")).toMatchObject({ location: "api" });
});
