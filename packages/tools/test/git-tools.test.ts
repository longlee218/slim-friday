import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectsContext } from "../src/effects/effects-context";
import { isPlainName } from "../src/effects/git-args";
import { createCreateProjectTool } from "../src/effects/tools/CreateProjectTool/create-project-tool";
import { createCreatePullRequestTool } from "../src/effects/tools/CreatePullRequestTool/create-pull-request-tool";
import { createGitPushTool } from "../src/effects/tools/GitPushTool/git-push-tool";
import { createMergeBranchTool } from "../src/effects/tools/MergeBranchTool/merge-branch-tool";

type Result = { content: { text: string }[]; isError?: boolean };
const call = (t: { handler: (a: never, e: unknown) => Promise<unknown> }, args: object) =>
  t.handler(args as never, {}) as Promise<Result>;
const text = (r: Result) => r.content[0]?.text ?? "";

/** Run git in `cwd` and return stdout (throws on failure). */
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

/** A repo with one commit on main, a bare remote named origin, and a ctx whose `gh` calls are recorded. */
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gitt-")));
  const ws = join(base, "ws");
  const remote = join(base, "remote");
  mkdirSync(ws);
  git(base, "init", "--bare", "-b", "main", remote);
  git(ws, "init", "-b", "main");
  git(ws, "config", "user.email", "t@t");
  git(ws, "config", "user.name", "t");
  writeFileSync(join(ws, "a.txt"), "one\n");
  git(ws, "add", ".");
  git(ws, "commit", "-m", "init");
  git(ws, "remote", "add", "origin", remote);
  const calls: string[][] = [];
  const ctx: EffectsContext = {
    botId: "ann",
    workspaces: [ws],
    home: join(base, "home"),
    isSensitive: () => false,
    run: async (cmd, cwd) => {
      calls.push(cmd);
      if (cmd[0] === "gh") return { code: 0, out: "https://github.com/o/r/pull/7\n" };
      const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
    },
  };
  return { base, ws, remote, ctx, calls };
}

test("isPlainName refuses option-like, refspec-like and traversal names", () => {
  expect(isPlainName("feature/x-1.2")).toBe(true);
  for (const bad of ["--force", "+main", "a:b", "x y", "../a", "a/../b", ""])
    expect(isPlainName(bad)).toBe(false);
});

test("GitPush pushes a feature branch to the remote", async () => {
  const { ws, remote, ctx } = setup();
  git(ws, "checkout", "-b", "feat");
  const r = await call(createGitPushTool(ctx), { workspace: ws, remote: "origin", branch: "feat" });
  expect(r.isError).toBeUndefined();
  expect(git(remote, "branch", "--list", "feat")).toContain("feat");
});

test("GitPush refuses bad names and an ungranted workspace before any git call", async () => {
  const { base, ws, ctx, calls } = setup();
  const push = createGitPushTool(ctx);
  for (const branch of ["--force", "+main", "a:b", "x y", "../a"])
    expect((await call(push, { workspace: ws, remote: "origin", branch })).isError).toBe(true);
  const other = await call(push, { workspace: base, remote: "origin", branch: "main" });
  expect(other.isError).toBe(true);
  expect(calls).toEqual([]);
});

test("MergeBranch refuses a dirty worktree and aborts a conflict cleanly", async () => {
  const { ws, ctx } = setup();
  const merge = createMergeBranchTool(ctx);
  git(ws, "checkout", "-b", "feat");
  writeFileSync(join(ws, "a.txt"), "feat\n");
  git(ws, "commit", "-am", "feat");
  git(ws, "checkout", "main");
  writeFileSync(join(ws, "a.txt"), "main\n");
  const dirty = await call(merge, { workspace: ws, from: "feat", into: "main" });
  expect(dirty.isError).toBe(true);
  expect(text(dirty)).toContain("uncommitted");
  git(ws, "commit", "-am", "main");
  const conflict = await call(merge, { workspace: ws, from: "feat", into: "main" });
  expect(conflict.isError).toBe(true);
  expect(text(conflict)).toContain("conflict");
  expect(git(ws, "status", "--porcelain")).toBe("");
});

test("MergeBranch merges a clean branch", async () => {
  const { ws, ctx } = setup();
  git(ws, "checkout", "-b", "feat");
  writeFileSync(join(ws, "b.txt"), "b\n");
  git(ws, "add", ".");
  git(ws, "commit", "-m", "b");
  const r = await call(createMergeBranchTool(ctx), { workspace: ws, from: "feat", into: "main" });
  expect(r.isError).toBeUndefined();
  expect(git(ws, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(existsSync(join(ws, "b.txt"))).toBe(true);
});

test("CreatePullRequest passes exactly the expected argv to gh and returns the URL", async () => {
  const { ws, ctx, calls } = setup();
  const r = await call(createCreatePullRequestTool(ctx), {
    workspace: ws,
    base: "main",
    head: "feat",
    title: "Add b",
    body: "Body",
  });
  expect(calls).toEqual([
    [
      "gh",
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "feat",
      "--title",
      "Add b",
      "--body",
      "Body",
    ],
  ]);
  expect(text(r)).toBe("https://github.com/o/r/pull/7");
});

test("CreateProject makes an initialised repo and refuses a bad name or an existing dir", async () => {
  const { base, ctx } = setup();
  const projects = join(base, "projects");
  const create = createCreateProjectTool(ctx, projects);
  const r = await call(create, { name: "shop" });
  expect(text(r)).toContain(join(projects, "shop"));
  expect(git(join(projects, "shop"), "rev-parse", "--is-inside-work-tree")).toBe("true");
  expect((await call(create, { name: "Bad Name" })).isError).toBe(true);
  expect((await call(create, { name: "shop" })).isError).toBe(true);
});
