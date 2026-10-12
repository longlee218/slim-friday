import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { insertWorktree, type WorktreeRow } from "../src/storage/worktree-store";
import { taskBranch } from "../src/workspaces/clone-safety";
import { createTaskClone } from "../src/workspaces/task-clone";
import { g, makeRepo } from "./git-fixture";
import { addRepo, clearWorkspaces, makeEnv } from "./helpers";

/**
 * Test-only: a LEGACY task clone, made the way the app did before Rev 15 (the app makes none any more): `git clone
 * --local` of `repoPath` into `workspaces/<ws>/repos/<repo>/worktrees/<taskId>` on a `friday/` branch, plus its
 * `worktrees` row and task scratch dir. Phase 4 deletes the clone code; until then old rows must keep working.
 */
export async function makeLegacyClone(
  env: ReturnType<typeof makeEnv>,
  o: { repo: string; repoPath: string; taskId: string; threadId?: string; workspace?: string },
): Promise<WorktreeRow> {
  const workspace = o.workspace ?? "main";
  const ws = workspacePaths(env.home).workspace(workspace);
  const cloneRoot = ws.repo(o.repo).worktrees;
  const clonePath = join(cloneRoot, o.taskId);
  const branch = taskBranch(o.taskId, "add b");
  const made = await createTaskClone({
    repoPath: o.repoPath,
    clonePath,
    cloneRoot,
    base: "main",
    branch,
    author: { name: "Test User", email: "test@example.com" },
  });
  const wt: WorktreeRow = {
    taskId: o.taskId,
    threadId: o.threadId ?? "th",
    repo: o.repo,
    repoPath: o.repoPath,
    path: clonePath,
    branch,
    base: "main",
    prUrl: null,
    createdAt: Date.now(),
    workspace,
    baseSha: made.baseSha,
    originUrl: made.originUrl,
    delivery: made.originUrl?.includes("github.com") ? "pr" : "local",
    status: "active",
    patchPath: null,
    deliveredAt: null,
  };
  insertWorktree(env.db, wt);
  mkdirSync(ws.task(o.taskId).root, { recursive: true });
  return wt;
}

/** Test-only: a real owner repo (no origin unless `origin`) registered in workspace `main`, and a way to start legacy clones of it. */
export async function cloneEnv(origin?: string) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  if (origin) await g(src.repo, "remote", "add", "origin", origin);
  addRepo(env.home, "ext", { gitAuthor: "Test User <test@example.com>" }, { path: src.repo });
  const repo = { name: "ext", path: src.repo };
  const deps = { db: env.db, config: env.config } as never;
  /** Start a legacy clone for `taskId` (a UUID); throws when refused. */
  const start = (taskId: string, threadId = "th") =>
    makeLegacyClone(env, { repo: "ext", repoPath: src.repo, taskId, threadId });
  /** Commit `name` with `content` inside a clone. */
  const commit = async (path: string, name: string, content: string) => {
    writeFileSync(join(path, name), content);
    await g(path, "add", name);
    await g(path, "commit", "-qm", `add ${name}`);
  };
  return { env, src, repo, deps, start, commit };
}

/** A task id from a short hex prefix (UUID shape). */
export const tid = (hex8: string, n = 1): string =>
  `${hex8}-1111-2222-3333-${String(n).padStart(12, "0")}`;
