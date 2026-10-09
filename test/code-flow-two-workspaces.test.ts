import { afterAll, expect, test } from "bun:test";
/** Same fake SDK as the main code-flow tests, copied small: plan approves, exec commits b.txt. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createGitMcp } from "../src/mcp/git-mcp";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { getWorktreeByThread } from "../src/storage/worktree-store";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { g, makeRepo } from "./git-fixture";
import {
  addRepo,
  BRIEF,
  clearWorkspaces,
  delegatingQuery,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

const git = createGitMcp();
afterAll(() => git.close());

/** Adds a managed clone `real` to workspace `ws` with the given commit author. */
async function addCloneRepo(home: string, ws: string, author: string, channels: string[] = []) {
  const src = await makeRepo("main");
  const clone = workspacePaths(home).workspace(ws).repo("real").clone;
  addRepo(
    home,
    "real",
    { description: ws, gitAuthor: author },
    { workspace: ws, path: clone, channels },
  );
  await g(home, "clone", "-q", src.repo, clone);
  await g(clone, "config", "user.email", "x@example.com");
  await g(clone, "config", "user.name", "t");
  return clone;
}

/** Fake SDK recording every run; the plan stage submits a plan, the exec stage commits a file. */
function fakeSdk(seen: any[]) {
  return (a: any) => {
    seen.push(a);
    const o = a.options;
    return (async function* () {
      if (o.permissionMode === "plan") {
        const r = await o.canUseTool(EXIT_PLAN_MODE_TOOL_NAME, { plan: "repo: real\nadd b" }, {});
        if (r.behavior === "allow") throw new Error("process aborted");
        yield resultMsg({ result: "plan rejected" });
        return;
      }
      writeFileSync(join(o.cwd, "b.txt"), "two\n");
      await g(o.cwd, "add", "b.txt");
      await g(o.cwd, "-c", "user.email=x@example.com", "-c", "user.name=t", "commit", "-qm", "b");
      yield resultMsg({ result: "done", session_id: "sess-exec" });
    })();
  };
}

const msg = (text: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});

/** Env with workspace `w-b` (repo `real`, author Bee) already holding the thread's worktree. */
async function started() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  await addCloneRepo(env.home, "w-b", "Bee <bee@example.com>", [TEST_CHANNEL]);
  const seen: any[] = [];
  const gw = stubGateway({
    confirm: async () => ({ approved: false, reason: "no PR" }),
    askChoice: async (a) => a.options[0],
  });
  const handle = createTaskHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: gw,
    queryFn: delegatingQuery([{ brief: BRIEF }], fakeSdk(seen), []) as never,
  });
  await handle(msg("add b"));
  return { env, seen, handle };
}

test("two workspaces with repo `real`: a follow-up stays in the worktree's workspace", async () => {
  const { env, seen, handle } = await started();
  // An alphabetically earlier workspace gains the same repo name after the worktree exists.
  await addCloneRepo(env.home, "w-a", "Aye <aye@example.com>");
  const n = seen.length;
  await handle(msg("also c"));
  expect(seen).toHaveLength(n + 1);
  const wt = getWorktreeByThread(env.db, "th1")!;
  expect(seen[n].options.cwd).toContain("/w-b/");
  expect(seen[n].options.mcpServers.git.env.GIT_AUTHOR_EMAIL).toBe("bee@example.com");
  expect(wt.path).toContain("/w-b/");
});

test("channel remapped to a workspace with another clone of `real`: follow-up refused, no run, no wrong author", async () => {
  const { env, seen, handle } = await started();
  await addCloneRepo(env.home, "w-a", "Aye <aye@example.com>");
  // The channel now routes to w-a (w-b unmapped): w-a's `real` is not the worktree's clone.
  addRepo(
    env.home,
    "real",
    { gitAuthor: "Aye <aye@example.com>" },
    {
      workspace: "w-a",
      channels: [TEST_CHANNEL],
      path: workspacePaths(env.home).workspace("w-a").repo("real").clone,
    },
  );
  addRepo(
    env.home,
    "real",
    { gitAuthor: "Bee <bee@example.com>" },
    {
      workspace: "w-b",
      channels: [],
      path: workspacePaths(env.home).workspace("w-b").repo("real").clone,
    },
  );
  const n = seen.length;
  const rows = () => env.db.query("SELECT count(*) AS n FROM tasks").get();
  const before = rows();
  const reply = await handle(msg("also c"));
  expect(reply).toContain("not in this channel's workspace");
  expect(seen).toHaveLength(n); // the agent never ran with w-a's identity
  expect(rows()).toEqual(before); // refusal made no task row
});

test("channel remapped to a workspace without that repo: follow-up refused, worktree untouched", async () => {
  const { env, seen, handle } = await started();
  addRepo(env.home, "other", {}, { workspace: "w-c", channels: [TEST_CHANNEL] });
  addRepo(
    env.home,
    "real",
    {},
    {
      workspace: "w-b",
      channels: [],
      path: workspacePaths(env.home).workspace("w-b").repo("real").clone,
    },
  );
  const n = seen.length;
  const reply = await handle(msg("also c"));
  expect(reply).toContain("not in this channel's workspace");
  expect(seen).toHaveLength(n);
  expect(getWorktreeByThread(env.db, "th1")).not.toBeNull();
});

test("cleanup: still works from an unmapped channel (recovery path) and runs no agent", async () => {
  const { env, seen, handle } = await started();
  const wt = getWorktreeByThread(env.db, "th1")!;
  // The channel was unmapped after the task ran: normal messages are refused, `cleanup:` is not.
  addRepo(
    env.home,
    "real",
    {},
    {
      workspace: "w-b",
      channels: [],
      path: workspacePaths(env.home).workspace("w-b").repo("real").clone,
    },
  );
  expect(await handle({ ...msg("also c"), channelId: "100000000000000099" })).toContain(
    "not linked to a workspace",
  );
  const n = seen.length;
  const reply = await handle({ ...msg("cleanup:"), channelId: "100000000000000099" });
  expect(reply).toContain("Removed");
  expect(existsSync(wt.path)).toBe(false);
  expect(getWorktreeByThread(env.db, "th1")).toBeNull();
  expect(seen).toHaveLength(n);
});
