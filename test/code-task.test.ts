import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalGateway, ApprovalRequest } from "../src/approvals/approval-types";
import { parseMessageCommand } from "../src/orchestrator/message-commands";
import {
  BASH_TOOL_NAME,
  SEND_FEEDBACK_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { runDevWorker } from "./dev-worker-fixture";
import { addLocation, clearWorkspaces, DEV_REQUEST, makeEnv, stubGateway } from "./helpers";

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
 * Run one dev message (a fake lead dispatches it to a dev worker); capture the SDK options of its run.
 * `gw` answers the owner-decided tools of the run.
 */
async function runCodeTask(gw?: ApprovalGateway) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const location = addLocation(env.home, "location"); // managed clone (code tasks need one)
  const { runs, reply } = await runDevWorker(env, DEV_REQUEST, { gw });
  return { env, opts: runs[0], reply, location, qa: runs };
}

test("parseMessageCommand: `/stop` is a command; text forms, `go` and `task:` are plain messages", () => {
  expect(parseMessageCommand(" /Stop ")).toEqual({ kind: "stop" });
  for (const t of [
    "stop",
    " Stop ",
    "stop it",
    "cleanup:",
    "task: add a file",
    "what is x?",
    "location:api how",
    "go",
    "go +1.5",
    "/go",
    "/go +2",
  ])
    expect(parseMessageCommand(t)).toEqual({ kind: "message" });
});

test("code task (a dispatched worker) runs in default mode, never bypass, in the location with write tools and no allowedTools", async () => {
  const { gw } = fakeGateway();
  const { env, opts, location, qa } = await runCodeTask(gw);
  expect(qa).toHaveLength(1); // one run: no assistant turn before it
  // A worker is never auto-approved (no bypass flag, no classifier): the guard answers every call, a sandbox ask included.
  expect(opts.permissionMode).toBe("default");
  expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
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
  expect(env.db.query("SELECT cwd FROM sessions WHERE COALESCE(kind, '') != 'lead'").all()).toEqual(
    [],
  );
  expect(
    env.db.query("SELECT counts_toward_cap FROM turns WHERE role = 'developer'").all(),
  ).toEqual([{ counts_toward_cap: 1 }]);
});

test("canUseTool: writes only in the workspace; a feedback report is outside a worker envelope", async () => {
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

  // Bash never asks. A dispatched worker has an envelope: a tool the guard would ask about (SendFeedback) is unknown
  // = R2 = denied (fail closed), the owner is not bothered.
  expect((await can(BASH_TOOL_NAME, { command: "bun run lint" }, {})).behavior).toBe("allow");
  expect((await can(BASH_TOOL_NAME, { command: "bun add left-pad" }, {})).behavior).toBe("deny"); // not listed: unknown = R2
  expect((await can(BASH_TOOL_NAME, { command: "git push origin feat" }, {})).behavior).toBe(
    "deny",
  );
  expect((await can(SEND_FEEDBACK_TOOL_NAME, { type: "bug", title: "t" }, {})).behavior).toBe(
    "deny",
  );
  expect(asked).toHaveLength(0);
});

test("a tool the owner denies becomes a deny the agent can act on", async () => {
  const { gw } = fakeGateway(false);
  const { opts } = await runCodeTask(gw);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  const feedback = await can(SEND_FEEDBACK_TOOL_NAME, { type: "bug", title: "t" }, {});
  expect(feedback).toMatchObject({ behavior: "deny" });
});

test("PreToolUse hook denies dangerous Bash and lets allowlisted Bash run; a tool outside the worker envelope is denied even in bypass", async () => {
  const { gw } = fakeGateway();
  const { opts } = await runCodeTask(gw);
  const hook = opts.hooks.PreToolUse[0].hooks[0] as (i: any) => Promise<any>;
  const call = (command: string) =>
    hook({ hook_event_name: "PreToolUse", tool_name: BASH_TOOL_NAME, tool_input: { command } });
  expect((await call("sudo ls")).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(await call("ls notes.txt")).toEqual({ continue: true });
  expect((await call("less notes.txt")).hookSpecificOutput.permissionDecision).toBe("deny"); // a pager hangs
  const feedback = await hook({
    hook_event_name: "PreToolUse",
    tool_name: SEND_FEEDBACK_TOOL_NAME,
    tool_input: { type: "bug", title: "t" },
  });
  // A worker has an envelope: an owner-decided tool is outside it, so even in bypass it is denied.
  expect(feedback.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(await call("git status")).toEqual({ continue: true });
});
