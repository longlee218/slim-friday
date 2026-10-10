import type { GitData, GitMcp } from "../../mcp/git-mcp";
import { parseRemote } from "../../mcp/github-mcp";
import { GIT_TOOL } from "../../mcp/mcp-tool-names";
import { gitOut } from "../../repos/git-cli";
import type { WorktreeRow } from "../../storage/worktree-store";

/* The publish step of the PR gate: push the task branch and find the GitHub repo it goes to. The agent never
   pushes: only the app does, and only a branch it created (`friday/*` for clones, `agent/*` for old worktrees). */

/** Branch of a task clone: the only kind the app pushes from a clone. */
export const CLONE_PUBLISH_BRANCH = /^friday\//;
/** Branch of an old git-worktree row. */
const LEGACY_PUBLISH_BRANCH = /^agent\//;

/** True when `wt.branch` may be published (clones: `friday/*`; old worktree rows: `agent/*`). */
export const mayPublish = (wt: WorktreeRow): boolean =>
  (wt.baseSha !== null ? CLONE_PUBLISH_BRANCH : LEGACY_PUBLISH_BRANCH).test(wt.branch);

/**
 * Push the task branch, never forced. A clone has no remote: the app pushes to the owner repo's recorded origin
 * url, naming the branch explicitly (`HEAD:refs/heads/<branch>`). An old worktree row pushes through the git MCP.
 */
export async function pushBranch(git: GitMcp, wt: WorktreeRow): Promise<void> {
  if (wt.baseSha === null) {
    await git.call(GIT_TOOL.PUSH, {
      path: wt.path,
      remote: "origin",
      branch: wt.branch,
      setUpstream: true,
    });
    return;
  }
  if (!wt.originUrl) throw new Error("the repo has no origin url");
  // `--` keeps the url from ever reading as an option; the url shape was checked when the clone was made.
  await gitOut(["push", "--", wt.originUrl, `HEAD:refs/heads/${wt.branch}`], wt.path);
}

/** GitHub owner/repo the branch was pushed to: the clone's recorded origin, or `origin` of an old worktree. */
export async function originSlug(
  git: GitMcp,
  wt: WorktreeRow,
): Promise<{ owner: string; repo: string } | null> {
  if (wt.baseSha !== null) return wt.originUrl ? parseRemote(wt.originUrl) : null;
  const remotes: GitData = await git
    .call(GIT_TOOL.REMOTE, { path: wt.path, mode: "list" })
    .catch(() => ({}));
  const origin = (remotes.remotes as { name: string; fetchUrl?: string }[] | undefined)?.find(
    (x) => x.name === "origin",
  );
  return parseRemote(origin?.fetchUrl ?? "");
}
