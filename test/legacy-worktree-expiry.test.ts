import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DAY_MS, expireLegacyWorktrees } from "../src/lifecycle/clone-retention";
import { getWorktreeByTask, insertWorktree } from "../src/storage/worktree-store";
import { cloneEnv } from "./clone-fixture";
import { g, LEGACY_WT_FIELDS } from "./git-fixture";

// Legacy pre-P2.1 git-worktree rows expire on the retention age (real git, temp dirs, no network).

const OLD = Date.now() - 20 * DAY_MS;
type Env = Awaited<ReturnType<typeof cloneEnv>>;

/** Insert a legacy row (no base_sha) for `path` in the source repo. */
function legacyRow(e: Env, id: string, path: string, branch: string, at: number) {
  insertWorktree(e.env.db, {
    ...LEGACY_WT_FIELDS,
    taskId: id,
    threadId: `th-${id}`,
    repo: "ext",
    repoPath: e.src.repo,
    path,
    branch,
    base: "main",
    createdAt: at,
  });
}

/** Register a real `git worktree` under the expected worktrees dir and insert its legacy row. */
async function legacy(e: Env, id: string, branch: string, at: number) {
  const path = join(e.env.paths.workspace("main").repo("ext").worktrees, id);
  await g(e.src.repo, "worktree", "add", "-q", "-b", branch, path);
  legacyRow(e, id, path, branch, at);
  return path;
}

test("old legacy worktree: git worktree + agent/* branch + row go; a recent one stays", async () => {
  const e = await cloneEnv();
  const oldPath = await legacy(e, "old1", "agent/old1", OLD);
  const newPath = await legacy(e, "new1", "agent/new1", Date.now());
  expect(await expireLegacyWorktrees(e.env.db, e.env.home, 14)).toEqual(["old1"]);
  expect(existsSync(oldPath)).toBe(false);
  expect(existsSync(newPath)).toBe(true);
  expect(getWorktreeByTask(e.env.db, "old1")).toBeNull();
  expect(getWorktreeByTask(e.env.db, "new1")).not.toBeNull();
  const branches = await g(e.src.repo, "branch", "--list");
  expect(branches).not.toContain("agent/old1");
  expect(branches).toContain("agent/new1");
  expect(await g(e.src.repo, "worktree", "list")).not.toContain("old1");
});

test("an owner branch (not agent/*|friday/*) is never deleted; the worktree still goes", async () => {
  const e = await cloneEnv();
  const path = await legacy(e, "old2", "feature-x", OLD);
  expect(await expireLegacyWorktrees(e.env.db, e.env.home, 14)).toEqual(["old2"]);
  expect(existsSync(path)).toBe(false);
  expect(await g(e.src.repo, "branch", "--list")).toContain("feature-x");
});

test("a row whose path is outside the expected worktrees dir is refused and kept", async () => {
  const e = await cloneEnv();
  legacyRow(e, "out", join(e.src.root, "precious"), "agent/out", OLD);
  expect(await expireLegacyWorktrees(e.env.db, e.env.home, 14)).toEqual([]);
  expect(getWorktreeByTask(e.env.db, "out")).not.toBeNull();
});

test("clone rows (base_sha set) are not touched by the legacy expiry", async () => {
  const e = await cloneEnv();
  const wt = await e.start("aaaaaaaa-1111-2222-3333-000000000001");
  e.env.db.query("UPDATE worktrees SET created_at = ? WHERE task_id = ?").run(OLD, wt.taskId);
  expect(await expireLegacyWorktrees(e.env.db, e.env.home, 14)).toEqual([]);
  expect(existsSync(wt.path)).toBe(true);
});
