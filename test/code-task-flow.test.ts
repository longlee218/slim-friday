import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitMcp } from "../src/mcp/git-mcp";
import { insertTask } from "../src/storage/run-store";
import { getSession } from "../src/storage/session-store";
import { getWorktreeByThread } from "../src/storage/worktree-store";
import { createTaskHandler } from "../src/tasks/handle-task";

/** The real git MCP server (pinned package), shared by the tests of this file. */
const git = createGitMcp();
afterAll(() => git.close());

import { workspacePaths } from "../src/config/workspace-paths";
import { g, makeRepo } from "./git-fixture";
import { addWorkspace, clearWorkspaces, makeEnv, resultMsg, stubGateway } from "./helpers";

/** Env with one workspace `real` whose repo/ is a real git clone (a managed clone). */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  const clone = workspacePaths(env.home).workspace("real").repo;
  addWorkspace(
    env.home,
    "real",
    { description: "test repo", gitAuthor: "Test User <test@example.com>" },
    clone,
  );
  await g(env.home, "clone", "-q", src.repo, clone);
  await g(clone, "config", "user.email", "test@example.com");
  await g(clone, "config", "user.name", "t");
  return { env, clone };
}

/** Gateway that approves plans/tools and answers the PR offer with `pr`. */
function gateway(pr: boolean) {
  const confirms: string[] = [];
  const gw = stubGateway({
    confirm: async (req) => {
      confirms.push(req.summary);
      return pr ? { approved: true } : { approved: false, reason: "owner declined" };
    },
    askChoice: async (a) => a.options[0],
  });
  return { gw, confirms };
}

/**
 * Fake SDK: the plan stage submits a plan (and is aborted like the real flow);
 * the execute stage writes + commits a file in its cwd.
 */
function fakeSdk(
  seen: any[],
  commit = ["-c", "user.email=test@example.com", "-c", "user.name=t"],
  msg = "add b",
) {
  return (a: any) => {
    seen.push(a);
    const o = a.options;
    return (async function* () {
      if (o.permissionMode === "plan") {
        const r = await o.canUseTool("ExitPlanMode", { plan: "repo: real\nadd b.txt" }, {});
        if (r.behavior === "allow") throw new Error("process aborted"); // flow aborts the plan stage
        yield resultMsg({ result: "plan rejected" });
        return;
      }
      writeFileSync(join(o.cwd, "b.txt"), "two\n");
      await g(o.cwd, "add", "b.txt");
      await g(o.cwd, ...commit, "commit", "-qm", msg);
      yield resultMsg({ result: "Xong, đã thêm b.txt", session_id: "sess-exec" });
    })();
  };
}

const msg_ = (text: string, threadId = "th1") => ({ source: "t", userId: "u", threadId, text });

test("task: plan approved -> worktree -> execute in worktree -> PR offered; follow-up resumes there; cleanup", async () => {
  const { env, clone } = await setup();
  const seen: any[] = [];
  const { gw, confirms } = gateway(false);
  const handle = createTaskHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: gw,
    queryFn: fakeSdk(seen) as never,
  });

  const reply = await handle(msg_("task: add b.txt"));
  // Stage 1: plan mode in scratch, repo read-only via additionalDirectories.
  expect(seen[0].options.permissionMode).toBe("plan");
  expect(seen[0].options.additionalDirectories).toEqual([realpathSync(clone)]);
  // Stage 2: runs in the worktree, default mode, commits allowed by guard.
  const wt = getWorktreeByThread(env.db, "th1")!;
  expect(wt.repo).toBe("real");
  expect(wt.branch).toMatch(/^agent\//);
  expect(seen).toHaveLength(2);
  expect(seen[1].options.cwd).toBe(realpathSync(wt.path));
  expect(seen[1].options.permissionMode).toBeUndefined();
  const gitEnv = seen[1].options.mcpServers.git.env;
  expect(gitEnv.GIT_AUTHOR_EMAIL).toBe("test@example.com");
  expect(gitEnv.GIT_COMMITTER_EMAIL).toBe("test@example.com");
  expect(gitEnv.GIT_BASE_DIR).toBe(realpathSync(wt.path)); // sandboxed to the worktree
  expect(seen[1].options.mcpServers.git.args.length).toBe(1); // official git MCP
  expect(seen[0].options.mcpServers.git).toBeDefined(); // plan stage: git read tools (guarded)
  expect(seen[1].options.resume).toBeUndefined();
  // Plan saved for the executor; PR offered with the commit; declined -> branch ready.
  expect(
    readFileSync(join(env.home, "workspaces", "real", "tasks", wt.taskId, "plan.md"), "utf8"),
  ).toContain("add b.txt");
  expect(confirms[0]).toContain("1 commit");
  expect(reply).toContain("Xong");
  expect(reply).toContain("not pushed");
  expect(getSession(env.db, "th1")).toMatchObject({ cwd: realpathSync(wt.path), repo: "real" });
  // The clone itself is untouched.
  expect(await g(clone, "status", "--short")).toBe("");

  // Follow-up (no prefix) in the same thread: same worktree, resumed session.
  await handle(msg_("also add c"));
  expect(seen[2].options.cwd).toBe(realpathSync(wt.path));
  expect(seen[2].options.resume).toBe("sess-exec");

  // cleanup: removes worktree dir, branch row and session.
  expect(await handle(msg_("cleanup:"))).toContain("Removed");
  expect(existsSync(wt.path)).toBe(false);
  expect(getWorktreeByThread(env.db, "th1")).toBeNull();
});

test("code task needs a managed clone; unmanaged working copies are refused", async () => {
  const env = makeEnv();
  const src = await makeRepo("main"); // outside AGENT_HOME/repos
  clearWorkspaces(env.home);
  addWorkspace(env.home, "wc", {}, src.repo);
  const { gw } = gateway(false);
  const handle = createTaskHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: gw,
  });
  expect(await handle(msg_("task: do it"))).toContain("Code tasks need a workspace clone");
});

test("busy when the code-task cap is reached", async () => {
  const { env } = await setup();
  for (const id of ["a", "b"]) {
    insertTask(env.db, { id, threadId: id, source: "t", repo: "real", type: "code" });
  }
  const { gw } = gateway(false);
  const handle = createTaskHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: gw,
  });
  expect(await handle(msg_("task: x"))).toContain("busy");
});

test("plan rejected -> no worktree is created", async () => {
  const { env } = await setup();
  const seen: any[] = [];
  const gw = stubGateway({
    request: async () => ({ approved: false }),
    requestPlan: async () => ({ approved: false, reason: "owner rejected plan" }),
  });
  const handle = createTaskHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: gw,
    queryFn: fakeSdk(seen) as never,
  });
  expect(await handle(msg_("task: x"))).toContain("plan rejected");
  expect(getWorktreeByThread(env.db, "th1")).toBeNull();
  expect(seen).toHaveLength(1);
});

test("commits must carry the owner's identity: wrong author or attribution blocks the PR offer", async () => {
  for (const [commit, msg] of [
    [["-c", "user.email=claude@anthropic.com", "-c", "user.name=Claude"], "add b"],
    [
      ["-c", "user.email=test@example.com", "-c", "user.name=t"],
      "add b\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>",
    ],
  ] as const) {
    const { env } = await setup();
    const { gw, confirms } = gateway(true);
    const handle = createTaskHandler({
      git,
      db: env.db,
      config: env.config,
      approvals: gw,
      queryFn: fakeSdk([], [...commit], msg) as never,
    });
    const reply = await handle(msg_("task: add b.txt"));
    expect(reply).toContain("PR not offered");
    expect(confirms).toHaveLength(0);
  }
});

test("no commit identity configured -> refused before any worktree exists", async () => {
  const { env, clone } = await setup();
  addWorkspace(env.home, "real", {}, clone); // same clone, but no gitAuthor
  const { gw } = gateway(false);
  const handle = createTaskHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: gw,
    queryFn: fakeSdk([]) as never,
  });
  expect(await handle(msg_("task: x"))).toContain("No commit identity");
  expect(getWorktreeByThread(env.db, "th1")).toBeNull();
});
