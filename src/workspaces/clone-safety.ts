import { existsSync, lstatSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { isInside } from "../guardrails/paths";
import { gitOut, runGit } from "../repos/git-cli";

/* Checks before a task clone is made, and the one safe way to remove it. A failed check throws a
   `CloneRefusal`: its message is the one-line owner-facing refusal. */

/** Free disk the task clone needs (bytes); the refusal text derives from it. */
export const MIN_FREE_DISK_BYTES = 2 * 1024 ** 3;
/** Local branches listed in the "base not found" refusal. */
export const MAX_LISTED_BRANCHES = 20;
/** Branch name a task clone gets: `friday/<task8>-<slug>`. */
export const TASK_BRANCH_RE = /^friday\/[0-9a-f]{8}-[a-z0-9-]{1,30}$/;
/** Task id shape (UUID): the only name a clone dir may have under the clones root. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Shape of a base branch name (no leading `-`, so it can never read as a git option). */
const BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** A clone that must not be made; the message goes to the owner. */
export class CloneRefusal extends Error {}

/** Throw a refusal. */
const refuse = (msg: string): never => {
  throw new CloneRefusal(msg);
};

/** Lowercase `a-z0-9-` slug of `text` (<= 30 chars, no edge hyphens); "task" when nothing is left. */
export function branchSlug(text: string): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30)
    .replace(/^-+|-+$/g, "");
  return s || "task";
}

/** Task branch name from the task id and its title. */
export const taskBranch = (taskId: string, title: string): string =>
  `friday/${taskId.slice(0, 8)}-${branchSlug(title)}`;

/** Free bytes on the volume holding `path` (nearest existing ancestor). */
function freeBytes(path: string): number {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const s = statfsSync(p);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Validate `base` and the owner repo; returns the base commit sha. Local base only: nothing is fetched.
 * Refuses: no commits, bad/missing base (lists local branches), submodules, LFS, low disk.
 */
export async function preflight(
  repoPath: string,
  base: string,
  cloneRoot: string,
  minFree = MIN_FREE_DISK_BYTES,
): Promise<string> {
  if ((await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoPath)).code !== 0)
    refuse("The repo has no commits.");
  const shapeOk =
    BASE_RE.test(base) &&
    !base.includes("..") &&
    !base.includes("@{") &&
    !base.endsWith(".lock") &&
    !base.endsWith("/") &&
    (await runGit(["check-ref-format", "--branch", base], repoPath)).code === 0;
  if (!shapeOk) refuse("The base branch name is not valid.");
  const sha = await runGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`],
    repoPath,
  );
  if (sha.code !== 0) {
    const list = await gitOut(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      repoPath,
    );
    const names = list.split("\n").filter(Boolean).slice(0, MAX_LISTED_BRANCHES).join(", ");
    refuse(`Base branch "${base}" not found locally. Local branches: ${names || "none"}.`);
  }
  // A clone would not carry submodules or LFS objects: refuse instead of handing the agent a broken tree.
  if ((await runGit(["cat-file", "-e", `${base}:.gitmodules`], repoPath)).code === 0)
    refuse("The repo uses submodules, which task clones do not support.");
  const attrs = await runGit(["show", `${base}:.gitattributes`], repoPath);
  if (attrs.code === 0 && /filter=lfs/.test(attrs.stdout))
    refuse("The repo uses Git LFS, which task clones do not support.");
  if (freeBytes(cloneRoot) < minFree)
    refuse(`Not enough free disk space for a task clone (need ${minFree / 1024 ** 3} GB).`);
  return sha.stdout.trim();
}

/**
 * Remove a task clone directory. Refuses (returns false) a symlink, or unless the real path is strictly inside
 * `root` (the repo's worktrees dir): a bad DB row can never delete anything else. A missing dir is fine.
 */
export function safeRemoveClone(path: string, root: string): boolean {
  try {
    if (!existsSync(path)) return true;
    // A symlink is never followed: it could point at another clone inside the root.
    if (lstatSync(path).isSymbolicLink()) return false;
    const real = realpathSync(path);
    if (real === realpathSync(root) || !isInside(realpathSync(root), real)) return false;
    rmSync(real, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
