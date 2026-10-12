import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { runGit } from "../src/repos/git-cli";
import { deleteWorktree, getWorktreeByTask, insertWorktree } from "../src/storage/worktree-store";
import { cleanupWorktree } from "../src/workspaces/clone-cleanup";
import {
  branchSlug,
  CloneRefusal,
  MIN_FREE_DISK_BYTES,
  safeRemoveClone,
  taskBranch,
} from "../src/workspaces/clone-safety";
import { createTaskClone } from "../src/workspaces/task-clone";
import { cloneEnv } from "./clone-fixture";
import { g, LEGACY_WT_FIELDS, makeRepo } from "./git-fixture";
import { resultMsg, TEST_CHANNEL } from "./helpers";

// Independent local clone per code task (P2.1), real git in temp dirs, no network.

const author = { name: "Test User", email: "test@example.com" };
const BRANCH = "friday/abcdef12-add-b";
/** Config file of a repo's git dir (the dir name is spelled out piecewise only to keep the test readable). */
const GIT_DIR = ".git";

/** A clone of `repo` to make: its paths and a `run` that creates it. */
async function clone(repo: string, over: Partial<Parameters<typeof createTaskClone>[0]> = {}) {
  const cloneRoot = mkdtempSync(join(tmpdir(), "clones-"));
  const clonePath = join(cloneRoot, "t1");
  const run = () =>
    createTaskClone({
      repoPath: repo,
      clonePath,
      cloneRoot,
      base: "main",
      branch: BRANCH,
      author,
      ...over,
    });
  return { cloneRoot, clonePath, run };
}

/** What a refusal says (the promise rejects with a CloneRefusal). */
async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CloneRefusal);
  return (err as Error).message;
}

test("clone: branch, identity, no origin, base sha; the owner repo is untouched", async () => {
  const src = await makeRepo("main", true); // owner repo WITH an origin (a bare local one)
  const before = {
    status: await g(src.repo, "status", "--short"),
    branches: await g(src.repo, "branch", "--list"),
    worktrees: await g(src.repo, "worktree", "list"),
    refs: await g(src.repo, "for-each-ref"),
    config: readFileSync(join(src.repo, GIT_DIR, "config"), "utf8"),
  };
  const c = await clone(src.repo);
  const made = await c.run();
  expect(made.baseSha).toBe(await g(src.repo, "rev-parse", "main"));
  expect(made.originUrl).toBe(src.origin);
  expect(await g(c.clonePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  expect(await g(c.clonePath, "rev-parse", "HEAD")).toBe(made.baseSha);
  expect(await g(c.clonePath, "remote")).toBe(""); // nothing can push back into the owner repo
  expect(await g(c.clonePath, "config", "--local", "user.email")).toBe("test@example.com");
  expect(await g(c.clonePath, "config", "--local", "user.name")).toBe("Test User");
  // Owner repo: no worktree entry, no branch, same refs, config and status.
  expect(await g(src.repo, "status", "--short")).toBe(before.status);
  expect(await g(src.repo, "branch", "--list")).toBe(before.branches);
  expect(await g(src.repo, "worktree", "list")).toBe(before.worktrees);
  expect(await g(src.repo, "for-each-ref")).toBe(before.refs);
  expect(readFileSync(join(src.repo, GIT_DIR, "config"), "utf8")).toBe(before.config);
  expect(before.worktrees.split("\n")).toHaveLength(1);
});

test("clone: a repo without any remote works too (no fetch); the base is the LOCAL branch", async () => {
  const src = await makeRepo("develop");
  await g(src.repo, "switch", "-q", "-c", "other"); // HEAD elsewhere: --branch still picks the base
  writeFileSync(join(src.repo, "x.txt"), "x\n");
  await g(src.repo, "add", "-A");
  await g(src.repo, "commit", "-qm", "other");
  const c = await clone(src.repo, { base: "develop" });
  const made = await c.run();
  expect(made.originUrl).toBeNull();
  expect(existsSync(join(c.clonePath, "x.txt"))).toBe(false);
  expect(made.baseSha).toBe(await g(src.repo, "rev-parse", "develop"));
});

test("refuses: no commits; missing base (lists branches); bad base names; submodules; LFS; low disk", async () => {
  const empty = mkdtempSync(join(tmpdir(), "empty-"));
  await g(empty, "init", "-q", "-b", "main");
  expect(await refusal((await clone(empty)).run())).toBe("The repo has no commits.");

  const src = await makeRepo("main");
  await g(src.repo, "branch", "feature-x");
  const missing = await refusal((await clone(src.repo, { base: "nope" })).run());
  expect(missing).toContain('"nope" not found');
  expect(missing).toMatch(/feature-x/);
  for (const bad of ["-x", "a..b", "$(id)", "x.lock", "a/", "a@{1}", "-"])
    expect(await refusal((await clone(src.repo, { base: bad })).run())).toContain("not valid");

  const sub = await makeRepo("main");
  writeFileSync(join(sub.repo, ".gitmodules"), '[submodule "m"]\n\tpath = m\n');
  await g(sub.repo, "add", "-A");
  await g(sub.repo, "commit", "-qm", "sub");
  expect(await refusal((await clone(sub.repo)).run())).toContain("submodules");

  const lfs = await makeRepo("main");
  writeFileSync(join(lfs.repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  await g(lfs.repo, "add", "-A");
  await g(lfs.repo, "commit", "-qm", "lfs");
  expect(await refusal((await clone(lfs.repo)).run())).toContain("LFS");

  const c = await clone(src.repo, { minFreeBytes: Number.MAX_SAFE_INTEGER });
  expect(await refusal(c.run())).toContain("disk");
  expect(existsSync(c.clonePath)).toBe(false);
  expect(MIN_FREE_DISK_BYTES).toBe(2 * 1024 ** 3);
  // The refusal text derives from the constant (here the 2 GB default).
  expect(
    await refusal((await clone(src.repo, { minFreeBytes: Number.MAX_VALUE })).run()),
  ).toContain(`${Number.MAX_VALUE / 1024 ** 3} GB`);
});

test("a refused or failed clone leaves no directory behind", async () => {
  const src = await makeRepo("main");
  const bad = await clone(src.repo, { branch: "agent/zzz" }); // not a friday/<8 hex>-slug name
  expect(await refusal(bad.run())).toContain("branch name");
  expect(existsSync(bad.clonePath)).toBe(false);
});

test("a pre-existing clone dir is refused up front and left untouched", async () => {
  const src = await makeRepo("main");
  const existing = await clone(src.repo);
  mkdirSync(existing.clonePath);
  writeFileSync(join(existing.clonePath, "f"), "x");
  expect(await refusal(existing.run())).toContain("already exists");
  expect(readFileSync(join(existing.clonePath, "f"), "utf8")).toBe("x"); // not cleaned: not ours
});

/** Every file under the owner's object dir with a content hash (mtime is excluded: git may freshen a shared object's timestamp). */
function objectListing(repo: string): string[] {
  const root = join(repo, GIT_DIR, "objects");
  return (readdirSync(root, { recursive: true }) as string[])
    .map((f) => ({ f, s: statSync(join(root, f)) }))
    .filter((x) => x.s.isFile())
    .map((x) => `${x.f}:${x.s.size}:${Bun.hash(readFileSync(join(root, x.f)))}`)
    .sort();
}

test("clone + work in the clone never change the owner repo's objects or refs", async () => {
  const src = await makeRepo("main");
  const objectsBefore = objectListing(src.repo);
  const refsBefore = await g(src.repo, "for-each-ref");
  const c = await clone(src.repo);
  await c.run();
  writeFileSync(join(c.clonePath, "new.txt"), "n\n");
  await g(c.clonePath, "add", "-A");
  await g(c.clonePath, "commit", "-qm", "work");
  await g(c.clonePath, "gc", "-q");
  expect(objectListing(src.repo)).toEqual(objectsBefore);
  expect(await g(src.repo, "for-each-ref")).toBe(refsBefore);
  expect(await g(src.repo, "fsck")).not.toContain("error");
});

test("branch naming", () => {
  expect(branchSlug("Add the /login page, please!!")).toBe("add-the-login-page-please");
  expect(branchSlug("!!!")).toBe("task");
  expect(taskBranch("abcdef12-0000", "x".repeat(80))).toMatch(/^friday\/abcdef12-x{30}$/);
});

test("safeRemoveClone: only inside its root; symlinks and the root itself are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "root-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "keep"), "x");
  mkdirSync(join(root, "t1"));
  symlinkSync(outside, join(root, "link"));
  expect(safeRemoveClone(outside, root)).toBe(false);
  expect(safeRemoveClone(root, root)).toBe(false);
  expect(safeRemoveClone(join(root, "link"), root)).toBe(false); // resolves outside
  // A symlink to ANOTHER clone inside the root is refused too: that clone survives.
  mkdirSync(join(root, "t2"));
  symlinkSync(join(root, "t2"), join(root, "alias"));
  expect(safeRemoveClone(join(root, "alias"), root)).toBe(false);
  expect(existsSync(join(root, "t2"))).toBe(true);
  expect(existsSync(join(outside, "keep"))).toBe(true);
  expect(safeRemoveClone(join(root, "t1"), root)).toBe(true);
  expect(existsSync(join(root, "t1"))).toBe(false);
  expect(safeRemoveClone(join(root, "gone"), root)).toBe(true); // missing = already clean
});

/** Env + a real owner repo registered as an EXTERNAL working copy; `start` makes a LEGACY clone of it (see clone-fixture.ts). */
async function external() {
  const { env, src, repo, deps, start } = await cloneEnv();
  return { env, src, repo, deps, start };
}

const WHERE = { threadId: "th", channelId: "c" };
const TID = "abcdef12-1111-2222-3333-444455556666";

test("cleanup: removes the clone + row; a tampered row is refused; legacy rows go through git", async () => {
  const { env, src, start } = await external();
  const ok = { wt: await start(TID) };
  const cdeps = { db: env.db, agentHome: env.home, active: new Map<string, unknown>() };
  expect(await cleanupWorktree({ ...cdeps, active: new Map([["th", 1]]) }, WHERE)).toContain(
    "in use",
  );
  expect(await cleanupWorktree(cdeps, WHERE)).toContain("Removed the task clone");
  expect(existsSync(ok.wt.path)).toBe(false);
  expect(getWorktreeByTask(env.db, TID)).toBeNull();

  // A row whose path is outside the clones dir is never deleted.
  const victim = mkdtempSync(join(tmpdir(), "victim-"));
  insertWorktree(env.db, {
    taskId: "t9",
    threadId: "th9",
    repo: "ext",
    repoPath: src.repo,
    path: victim,
    branch: "b",
    base: "main",
    workspace: "main",
    baseSha: "x",
  });
  expect(await cleanupWorktree(cdeps, { threadId: "th9", channelId: "c" })).toContain("Refused");
  expect(existsSync(victim)).toBe(true);

  // Legacy row (no base_sha): a real `git worktree` of the owner repo is unregistered with its branch.
  const legacy = join(mkdtempSync(join(tmpdir(), "legacy-")), "wt");
  await g(src.repo, "worktree", "add", "-q", "-b", "agent/old", legacy, "main");
  insertWorktree(env.db, {
    taskId: "t8",
    threadId: "th8",
    repo: "ext",
    repoPath: src.repo,
    path: legacy,
    branch: "agent/old",
    base: "main",
    ...LEGACY_WT_FIELDS,
  });
  expect(await cleanupWorktree(cdeps, { threadId: "th8", channelId: "c" })).toContain("Removed");
  expect(await g(src.repo, "worktree", "list")).not.toContain("legacy-");
  expect(await g(src.repo, "branch", "--list", "agent/old")).toBe("");
});

test("cleanup: a tampered workspace or repo name is refused and nothing outside is deleted", async () => {
  const { env, src } = await external();
  const cdeps = { db: env.db, agentHome: env.home, active: new Map<string, unknown>() };
  // With `..` the removal root would widen to this dir: the victim sits inside it.
  const wide = env.paths.workspace("..").repo("..").worktrees;
  const victim = join(wide, "victim");
  mkdirSync(victim, { recursive: true });
  for (const [workspace, repo] of [
    ["..", ".."],
    ["main", ".."],
    ["Bad Name", "ext"],
  ]) {
    insertWorktree(env.db, {
      taskId: `t-${workspace}-${repo}`,
      threadId: "thx",
      repo,
      repoPath: src.repo,
      path: victim,
      branch: "b",
      base: "main",
      workspace,
      baseSha: "x",
    });
    expect(await cleanupWorktree(cdeps, { threadId: "thx", channelId: "c" })).toContain("Refused");
    expect(existsSync(victim)).toBe(true);
    deleteWorktree(env.db, `t-${workspace}-${repo}`);
  }
});

test("cleanup: a legacy row with a non-agent branch never deletes an owner branch", async () => {
  const { env, src } = await external();
  const cdeps = { db: env.db, agentHome: env.home, active: new Map<string, unknown>() };
  await g(src.repo, "branch", "keep-me");
  for (const [i, branch] of ["main", "keep-me", "--force"].entries()) {
    insertWorktree(env.db, {
      taskId: `l${i}`,
      threadId: `thl${i}`,
      repo: "ext",
      repoPath: src.repo,
      path: join(src.root, "none"),
      branch,
      base: "main",
      ...LEGACY_WT_FIELDS,
    });
    await cleanupWorktree(cdeps, { threadId: `thl${i}`, channelId: "c" });
  }
  expect(await g(src.repo, "branch", "--list", "main", "keep-me")).toContain("keep-me");
  expect(await g(src.repo, "branch", "--list", "main")).toContain("main");
});

test("Q&A refresh never runs on an owner checkout outside the workspace clones", async () => {
  const { env, src } = await external();
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: ((_a: unknown) =>
      (async function* () {
        yield resultMsg();
      })()) as never,
  });
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "q1",
    text: "[ask] what is here?",
  });
  expect(await runGit(["status", "--short"], src.repo)).toMatchObject({ stdout: "" });
});
