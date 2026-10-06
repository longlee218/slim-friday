import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalGateway, ApprovalRequest } from "../src/approvals/approval-types";
import { createTaskHandler } from "../src/tasks/handle-task";
import { parseTaskCommand } from "../src/tasks/task-commands";
import { addWorkspace, clearWorkspaces, makeEnv, resultMsg, stubGateway } from "./helpers";

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

/** Run one `task:` message and capture the SDK options the handler built. */
async function runCodeTask(text: string, gw?: ApprovalGateway) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const repo = addWorkspace(env.home, "repo"); // managed clone (code tasks need one)
  let opts: any;
  const queryFn = (a: any) => {
    opts = a.options;
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: queryFn as never,
    approvals: gw,
  });
  const reply = await handle({ source: "t", userId: "u", threadId: "t1", text });
  return { env, opts, reply, repo };
}

test("parseTaskCommand: stop, cleanup, task: prefix and repo: hint", () => {
  expect(parseTaskCommand(" Stop ")).toEqual({ kind: "stop" });
  expect(parseTaskCommand("stop it")).toMatchObject({ kind: "qa" });
  expect(parseTaskCommand("cleanup:")).toEqual({ kind: "cleanup", taskId: undefined });
  expect(parseTaskCommand("CLEANUP: abc")).toEqual({ kind: "cleanup", taskId: "abc" });
  expect(parseTaskCommand("task: add a file")).toEqual({
    kind: "code",
    repo: undefined,
    text: "add a file",
  });
  expect(parseTaskCommand("TASK:x")).toMatchObject({ kind: "code", text: "x" });
  expect(parseTaskCommand("what is x?")).toEqual({
    kind: "qa",
    repo: undefined,
    text: "what is x?",
  });
  expect(parseTaskCommand("repo:api how does auth work?")).toEqual({
    kind: "qa",
    repo: "api",
    text: "how does auth work?",
  });
  expect(parseTaskCommand("task: repo:api fix it")).toEqual({
    kind: "code",
    repo: "api",
    text: "fix it",
  });
});

test("code task without approvals is refused and never reaches the SDK", async () => {
  const { opts, reply } = await runCodeTask("task: do it");
  expect(reply).toContain("approval");
  expect(opts).toBeUndefined();
});

test("code task runs in plan mode in the scratch dir with write tools and no allowedTools", async () => {
  const { gw } = fakeGateway();
  const { env, opts, repo } = await runCodeTask("task: add a file", gw);
  expect(opts.permissionMode).toBe("plan");
  expect(opts.tools).toContain("Write");
  expect(opts.allowedTools).toBeUndefined(); // would bypass canUseTool
  expect(opts.cwd).toContain(join(env.home, "tasks"));
  expect(opts.additionalDirectories).toEqual([realpathSync(repo)]);
  expect(opts.canUseTool).toBeFunction();
  expect(opts.systemPrompt.append).toContain("plan mode");
  // No session is saved for code tasks.
  expect(env.db.query("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 0 });
  expect(env.db.query("SELECT type FROM tasks").get()).toEqual({ type: "code" });
});

test("canUseTool: plan goes to owner; writes only in scratch; risky Bash asks; denial reaches agent", async () => {
  const { gw, asked } = fakeGateway();
  const { opts } = await runCodeTask("task: x", gw);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;

  expect((await can("ExitPlanMode", { plan: "repo: repo\nstep 1" }, {})).behavior).toBe("allow");
  expect(asked[0]).toMatchObject({ kind: "plan", req: { detail: "repo: repo\nstep 1" } });

  expect(
    (await can("Write", { file_path: join(opts.cwd, "a.txt"), content: "x" }, {})).behavior,
  ).toBe("allow");
  expect((await can("Write", { file_path: "/etc/passwd", content: "x" }, {})).behavior).toBe(
    "deny",
  );
  expect((await can("Bash", { command: "rm -rf /tmp/x" }, {})).behavior).toBe("deny");
  expect(asked).toHaveLength(1); // allow/deny decisions never bother the owner

  expect((await can("Bash", { command: "bun add left-pad" }, {})).behavior).toBe("allow");
  expect(asked[1]).toMatchObject({ kind: "request", req: { tool: "Bash" } });

  const ans = await can(
    "AskUserQuestion",
    { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] },
    {},
  );
  expect(ans.updatedInput.answers).toEqual({ "Q?": "A" });
});

test("owner rejection becomes a deny message the agent can act on", async () => {
  const { gw } = fakeGateway(false);
  const { opts } = await runCodeTask("task: x", gw);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  const plan = await can("ExitPlanMode", { plan: "repo: repo\np" }, {});
  expect(plan.behavior).toBe("deny");
  expect(plan.message).toContain("rejected the plan");
  const bash = await can("Bash", { command: "bun add x" }, {});
  expect(bash).toMatchObject({ behavior: "deny" });
});

test("PreToolUse hook denies dangerous Bash and forces ask for unknown Bash", async () => {
  const { gw } = fakeGateway();
  const { opts } = await runCodeTask("task: x", gw);
  const hook = opts.hooks.PreToolUse[0].hooks[0] as (i: any) => Promise<any>;
  const call = (command: string) =>
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  expect((await call("sudo ls")).hookSpecificOutput.permissionDecision).toBe("deny");
  expect((await call("ls -la")).hookSpecificOutput.permissionDecision).toBe("ask");
  expect(await call("git status")).toEqual({ continue: true });
});
