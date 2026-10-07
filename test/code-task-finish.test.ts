import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { ApprovalGateway } from "../src/approvals/approval-types";
import { createGitMcp } from "../src/mcp/git-mcp";
import { GIT_TOOL } from "../src/mcp/mcp-tool-names";
import { openDb } from "../src/storage/db";
import { insertWorktree, type WorktreeRow } from "../src/storage/worktree-store";
import { finishCodeTask } from "../src/tasks/code-task-finish";
import { g, makeRepo } from "./git-fixture";
import { stubGateway } from "./helpers";

/** The real git MCP server (pinned package). */
const git = createGitMcp();
afterAll(() => git.close());

const me = { name: "Test User", email: "t@t.t" }; // makeRepo commits as t@t.t

/** Repo + bare origin and a worktree on `branch` with one commit; origin reads like a GitHub remote. */
async function setup(branch = "agent/x") {
  const r = await makeRepo("main", true);
  const wt = join(r.root, "wt");
  await git.call(GIT_TOOL.WORKTREE, {
    path: r.repo,
    mode: "add",
    worktreePath: wt,
    branch,
    commitish: "main",
  });
  await Bun.write(join(wt, "hello.md"), "hi\n");
  await g(wt, "add", "hello.md");
  await g(wt, "commit", "-qm", "feat: hello");
  // Fetch URL looks like GitHub (so owner/repo can be parsed); pushes still go to the local bare repo.
  await g(r.repo, "config", "remote.origin.pushurl", r.origin);
  await g(r.repo, "remote", "set-url", "origin", "git@github.com:Acme/widgets");
  const db = openDb(":memory:");
  const row: WorktreeRow = {
    taskId: "t1",
    threadId: "th",
    repo: "r",
    repoPath: r.repo,
    path: wt,
    branch,
    base: "main",
    prUrl: null,
    createdAt: Date.now(),
  };
  insertWorktree(db, row);
  return { ...r, wt, db, row };
}

/** Gateway whose PR offer is answered with `approve`. */
const gateway = (approve: boolean): ApprovalGateway =>
  stubGateway({ confirm: async () => ({ approved: approve }) });

const run = (s: Awaited<ReturnType<typeof setup>>, approve: boolean, createPr: any) =>
  finishCodeTask(
    { db: s.db, approvals: gateway(approve), git, createPr },
    {
      wt: s.row,
      taskId: "t1",
      threadId: "th",
      title: "t",
      body: "b",
      text: "done",
      signal: new AbortController().signal,
      author: me,
      githubAccount: "me",
    },
  );

const remoteHas = (s: { root: string; origin: string }, branch: string) =>
  g(s.root, `--git-dir=${s.origin}`, "rev-parse", "--verify", branch).then(
    () => true,
    () => false,
  );

test("approved: pushes the agent branch through the git MCP server, then creates the PR with owner/repo from origin", async () => {
  const s = await setup();
  const calls: any[] = [];
  const reply = await run(
    s,
    true,
    async (o: any) => (calls.push(o), { ok: true, url: "https://github.com/Acme/widgets/pull/7" }),
  );
  expect(reply).toContain("PR: https://github.com/Acme/widgets/pull/7");
  expect(calls[0]).toMatchObject({
    owner: "Acme",
    repo: "widgets",
    head: "agent/x",
    base: "main",
    account: "me",
  });
  expect(await remoteHas(s, "agent/x")).toBe(true);
  expect(s.db.query("SELECT pr_url FROM worktrees").get()).toEqual({
    pr_url: "https://github.com/Acme/widgets/pull/7",
  });
});

test("declined: nothing is pushed and no PR is created", async () => {
  const s = await setup();
  let created = 0;
  const reply = await run(s, false, async () => (created++, { ok: true, url: "u" }));
  expect(reply).toContain("not pushed");
  expect(created).toBe(0);
  expect(await remoteHas(s, "agent/x")).toBe(false);
});

test("only agent/* branches are ever published", async () => {
  const s = await setup("feature/x");
  let created = 0;
  const reply = await run(s, true, async () => (created++, { ok: true, url: "u" }));
  expect(reply).toContain("refusing to publish non-agent branch");
  expect(created).toBe(0);
  expect(await remoteHas(s, "feature/x")).toBe(false);
});

test("push failure and an unparseable remote are reported without creating a PR", async () => {
  let created = 0;
  const createPr = async () => (created++, { ok: true as const, url: "u" });
  const a = await setup();
  await g(a.repo, "config", "remote.origin.pushurl", join(a.root, "missing"));
  expect(await run(a, true, createPr)).toContain("PR failed");
  const b = await setup();
  await g(b.repo, "remote", "set-url", "origin", "https://example.com/not-github");
  await g(b.repo, "config", "remote.origin.pushurl", b.origin);
  expect(await run(b, true, createPr)).toContain("cannot parse origin remote");
  expect(created).toBe(0);
});

test("wrong commit author blocks the offer before anything is pushed", async () => {
  const s = await setup();
  const reply = await finishCodeTask(
    { db: s.db, approvals: gateway(true), git, createPr: async () => ({ ok: true, url: "u" }) },
    {
      wt: s.row,
      taskId: "t1",
      threadId: "th",
      title: "t",
      body: "b",
      text: "done",
      signal: new AbortController().signal,
      author: { name: "Someone Else", email: "else@example.com" },
    },
  );
  expect(reply).toContain("PR not offered");
  expect(await remoteHas(s, "agent/x")).toBe(false);
});
