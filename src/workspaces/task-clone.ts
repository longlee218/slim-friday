import { existsSync, mkdirSync } from "node:fs";
import { logEvent, logger } from "../observability/logger";
import { gitOut, runGit } from "../repos/git-cli";
import { CloneRefusal, preflight, safeRemoveClone, TASK_BRANCH_RE } from "./clone-safety";
import { safeOriginUrl } from "./origin-url";

/* LEGACY (Rev 15 phase 3: the app no longer creates task clones; phase 4 deletes this file): a plain `git clone --local` of the owner's
   repo into `workspaces/<ws>/repos/<name>/worktrees/<taskId>`. The owner repo's `.git` is only read:
   no worktree entry, no branch, no config change. Local base, no fetch, no `origin` in the clone. */

const log = logger.child({ module: "task-clone" });

/** What a created clone records about its origin. */
export interface CreatedClone {
  baseSha: string;
  /** `origin` url of the owner repo (read once, never fetched); null when it has none. */
  originUrl: string | null;
}

/** Create the clone on a new `branch` cut from the local `base`. Throws `CloneRefusal` or an Error; leaves nothing behind. */
export async function createTaskClone(o: {
  repoPath: string;
  clonePath: string;
  /** Parent dir of every clone of this repo (the removal root). */
  cloneRoot: string;
  base: string;
  branch: string;
  author: { name: string; email: string };
  minFreeBytes?: number;
}): Promise<CreatedClone> {
  if (!TASK_BRANCH_RE.test(o.branch)) throw new CloneRefusal("The task branch name is not valid.");
  // Never reuse a directory: the cleanup below must only ever remove what this call created.
  if (existsSync(o.clonePath)) throw new CloneRefusal("A clone for this task already exists.");
  mkdirSync(o.cloneRoot, { recursive: true, mode: 0o700 });
  const baseSha = await preflight(o.repoPath, o.base, o.cloneRoot, o.minFreeBytes);
  try {
    // `--` ends options, so a path can never read as a git flag. `--local` hardlinks the objects.
    await gitOut(
      ["clone", "--local", "--branch", o.base, "--single-branch", "--", o.repoPath, o.clonePath],
      o.cloneRoot,
    );
    // Nothing in the clone may reach the owner checkout: drop the remote. The PR push (P2.2) is made by
    // the app with an explicit url, never through a clone remote.
    await gitOut(["remote", "remove", "origin"], o.clonePath);
    await gitOut(["switch", "-c", o.branch], o.clonePath);
    // Written once here (not read from the machine's global git user).
    await gitOut(["config", "--local", "user.name", o.author.name], o.clonePath);
    await gitOut(["config", "--local", "user.email", o.author.email], o.clonePath);
  } catch (err) {
    safeRemoveClone(o.clonePath, o.cloneRoot);
    throw err;
  }
  const origin = await runGit(["remote", "get-url", "origin"], o.repoPath);
  // An origin url with credentials is dropped (never stored or echoed): delivery then falls back to local.
  const safe = safeOriginUrl(origin.code === 0 ? origin.stdout.trim() || null : null);
  if (safe.refusedCredentials) logEvent(log, "clone.origin_credentials", {}, "warn");
  return { baseSha, originUrl: safe.url };
}
