import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectsContext } from "../src/effects/effects-context";
import { effectsTools } from "../src/effects/effects-server";
import { GIT_HARDEN, isPlainName } from "../src/effects/git-args";
import { createCreateProjectTool } from "../src/effects/tools/CreateProjectTool/create-project-tool";
import { createCreatePullRequestTool } from "../src/effects/tools/CreatePullRequestTool/create-pull-request-tool";
import { createGitPushTool } from "../src/effects/tools/GitPushTool/git-push-tool";
import { createMergeBranchTool } from "../src/effects/tools/MergeBranchTool/merge-branch-tool";

type Result = { content: { text: string }[]; isError?: boolean };
const call = (t: { handler: (a: never, e: unknown) => Promise<unknown> }, args: object) =>
  t.handler(args as never, {}) as Promise<Result>;
const text = (r: Result) => r.content[0]?.text ?? "";

/**
 * Run git in `cwd` and return stdout (throws on failure). The env is passed explicitly: Bun's default
 * is the startup env, which still holds a calling hook's GIT_DIR (the test preload drops it from
 * `process.env` only), and with it `git init --bare` would turn the real repo bare.
 */
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
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
    run: async (cmd, cwd, env) => {
      calls.push(cmd);
      if (cmd[0] === "gh") return { code: 0, out: "https://github.com/o/r/pull/7\n" };
      // Like the app: the given env goes over the process env.
      const p = Bun.spawnSync(cmd, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      });
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
  // Back on the branch the bot was on; main has the merge.
  expect(git(ws, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
  expect(git(ws, "show", "main:b.txt")).toBe("b");
});

test("a repo config that can run commands is refused before git runs; hooks never run", async () => {
  const { base, ws, ctx } = setup();
  const marker = join(base, "pwned");
  git(ws, "config", "core.fsmonitor", `touch ${marker}`);
  const merge = await call(createMergeBranchTool(ctx), {
    workspace: ws,
    from: "main",
    into: "main",
  });
  expect(merge.isError).toBe(true);
  expect(text(merge)).toContain("core.fsmonitor");
  expect(existsSync(marker)).toBe(false);
  git(ws, "config", "--unset", "core.fsmonitor");
  writeFileSync(join(ws, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${marker}\n`, {
    mode: 0o755,
  });
  git(ws, "checkout", "-b", "feat");
  const push = await call(createGitPushTool(ctx), {
    workspace: ws,
    remote: "origin",
    branch: "feat",
  });
  expect(push.isError).toBeUndefined();
  expect(existsSync(marker)).toBe(false);
});

test("effectsTools gives only the tools the bot names (all for the whole server)", () => {
  const { ctx } = setup();
  const names = (tools: string[]) => effectsTools(ctx, "/p", tools).map((t) => t.name);
  expect(names(["mcp__effects__GitPush"])).toEqual(["GitPush"]);
  expect(names(["mcp__effects"])).toHaveLength(5);
  expect(names(["Read"])).toEqual([]);
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
  expect(calls.at(-1)).toEqual([
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

test("a merge killed by the timeout is aborted and the bot's branch comes back", async () => {
  const { ws, ctx, calls } = setup();
  git(ws, "checkout", "-b", "feat");
  const killed: EffectsContext = {
    ...ctx,
    run: async (cmd, cwd) => {
      if (!cmd.includes("--no-ff")) return ctx.run(cmd, cwd);
      calls.push(cmd);
      return { code: 143, out: "" };
    },
  };
  const r = await call(createMergeBranchTool(killed), {
    workspace: ws,
    from: "feat",
    into: "main",
  });
  expect(r.isError).toBe(true);
  expect(calls.some((c) => c.includes("--abort"))).toBe(true);
  expect(git(ws, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
});

test("the owner's global git config is not used: a global url rewrite does not redirect a push", async () => {
  const { base, ws, remote, ctx } = setup();
  const other = join(base, "other");
  git(base, "init", "--bare", "-b", "main", other);
  const globalCfg = join(base, "gitconfig");
  writeFileSync(globalCfg, `[url "${other}"]\n\tinsteadOf = ${remote}\n`);
  git(ws, "checkout", "-b", "feat");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  try {
    const r = await call(createGitPushTool(ctx), {
      workspace: ws,
      remote: "origin",
      branch: "feat",
    });
    expect(r.isError).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
  }
  expect(git(remote, "branch", "--list", "feat")).toContain("feat");
  expect(git(other, "branch", "--list", "feat")).toBe("");
});

test("every git argv carries the hardening pins right after git", async () => {
  const { ws, ctx, calls } = setup();
  git(ws, "checkout", "-b", "feat");
  await call(createGitPushTool(ctx), { workspace: ws, remote: "origin", branch: "feat" });
  const gits = calls.filter((c) => c[0] === "git");
  expect(gits.length).toBeGreaterThan(0);
  for (const c of gits) expect(c.slice(1, 1 + GIT_HARDEN.length)).toEqual([...GIT_HARDEN]);
});

test("a repo config with core.worktree is refused before MergeBranch checks anything out", async () => {
  const { base, ws, ctx } = setup();
  git(ws, "config", "core.worktree", join(base, "elsewhere"));
  mkdirSync(join(base, "elsewhere"));
  git(ws, "checkout", "-b", "feat");
  const r = await call(createMergeBranchTool(ctx), { workspace: ws, from: "feat", into: "main" });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("core.worktree");
});
