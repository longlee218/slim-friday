import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../../config/agent-config";
import { claudePlansDir, workspacePaths } from "../../config/workspace-paths";
import type { GuardScope } from "../../guardrails/check-tool-call";
import { realOrSame } from "../../guardrails/paths";
import type { Repo, Workflow } from "../../repos/repo-registry";
import type { RoleDefinition } from "../../roles/role-types";
import type { RoleRunInput } from "./role-run-types";

/* Where a role run works and what it may touch, from role DATA (capabilities, background) and the run input. */

/** What `roleScope` decides for one run. */
export interface RoleScope {
  /** Working dir of the run (real path for a writing role). */
  cwd: string;
  /** Extra dirs the agent may use: the other repos, the thread's attachment copy, scratch and worktrees dirs of a writing role. */
  additionalDirectories: string[];
  /** Repos the run is about: the pinned one, else every repo it sees. */
  scope: Repo[];
  /** Claude session to resume, when there is one for this cwd. */
  sessionId?: string;
  /** Path rules of the guard. */
  guard: GuardScope;
  /** Writing role: where the agent may put a git worktree for the repo it runs in. */
  worktreesDir?: string;
  /** `full` when any repo in scope is: adds the repo-workflow rules to the prompt. */
  workflow: Workflow;
}

/**
 * Pick cwd, extra dirs, session and guard paths.
 * cwd: an explicit `resume` keeps its own; a background role works in the pinned repo, else the sole repo, else the
 * first registry repo (the rest are `additionalDirectories`); a foreground role keeps the thread's stored cwd when it
 * is still valid, else the pinned repo, the sole repo, or the neutral workspace dir over several repos. Claude sessions
 * are keyed by cwd, so a session is resumed only when its cwd is the run's.
 * A role with the `write` capability may write in every repo of the workspace, the worktrees dir, the task scratch
 * dir and the SDK plans dir; any other role may read only the registered repos (+ the workspace dirs).
 * Throws when a dir of a writing role is gone (the caller turns it into a failed result).
 */
export function roleScope(config: AgentConfig, i: RoleRunInput, role: RoleDefinition): RoleScope {
  const { repos, pinned } = i;
  const dirs = workspacePaths(config.agentHome).workspace(i.workspace);
  mkdirSync(dirs.cwd, { recursive: true });
  const scope = pinned ? [pinned] : repos;
  let cwd: string;
  let sessionId: string | undefined;
  if (i.resume) {
    // A background role resumes only inside a registered repo (an old session whose cwd was a plan scratch dir must not run as dev with no repo).
    if (role.background && !repos.some((r) => realOrSame(r.path) === realOrSame(i.resume!.cwd)))
      throw new Error("resume cwd is not a workspace repo");
    cwd = i.resume.cwd;
    sessionId = i.resume.sessionId;
  } else if (role.background) {
    cwd = pinned?.path ?? repos[0]?.path ?? dirs.cwd;
  } else {
    const stored = i.existing;
    const storedOk =
      stored && (stored.cwd === dirs.cwd || repos.some((r) => r.path === stored.cwd));
    cwd =
      pinned?.path ??
      (storedOk ? stored.cwd : repos.length > 1 ? dirs.cwd : (repos[0]?.path ?? dirs.cwd));
    if (stored && stored.cwd === cwd) sessionId = stored.session_id;
  }
  const workflow = scope.some((r) => r.workflow === "full") ? "full" : "lean";
  const others = pinned ? [] : repos.map((r) => r.path).filter((p) => p !== cwd);
  if (!role.capabilities.includes("write")) {
    // Full text of a long owner attachment (saved by ingress, read-only): readable only when this thread has one.
    const attached = workspacePaths(config.agentHome).attachments(i.threadId);
    const additionalDirectories = [...others, ...(existsSync(attached) ? [attached] : [])];
    return {
      cwd,
      additionalDirectories,
      scope,
      sessionId,
      workflow,
      guard: {
        readPaths: [cwd, ...additionalDirectories].map(realOrSame),
        gitReadRepos: scope.map((r) => realOrSame(r.path)),
      },
    };
  }
  const scratch = dirs.task(i.turnId).root;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  mkdirSync(dirs.worktrees, { recursive: true, mode: 0o700 });
  const real = {
    cwd: realpathSync(cwd),
    scratch: realpathSync(scratch),
    worktrees: realpathSync(dirs.worktrees),
  };
  const repoName = repos.find((r) => realOrSame(r.path) === real.cwd)?.name;
  return {
    cwd: real.cwd,
    additionalDirectories: [...others, real.scratch, real.worktrees],
    scope,
    sessionId,
    workflow,
    worktreesDir: repoName ? join(real.worktrees, repoName) : undefined,
    guard: {
      cwd: real.cwd,
      writePaths: [
        ...new Set([
          real.cwd,
          ...repos.map((r) => realOrSame(r.path)),
          real.worktrees,
          real.scratch,
          claudePlansDir(),
        ]),
      ],
      worktreeDirs: [real.worktrees],
    },
  };
}
