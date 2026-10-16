import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../../config/agent-config";
import { claudePlansDir, workspacePaths } from "../../config/workspace-paths";
import { realOrSame } from "../../policy/paths";
import type { RoleDefinition } from "../../roles/role-types";
import { controlScope } from "./control-scope";
import type { RoleRunInput } from "./role-run-types";
import type { RoleScope } from "./role-scope-types";

/* Where a role run works and what it may touch, from role DATA (capabilities, background) and the run input. */

/** Dirs of the run under AGENT_HOME that stay usable although AGENT_HOME is denied (guard `allowInside`). */
function grantedUnderHome(
  dirs: ReturnType<ReturnType<typeof workspacePaths>["workspace"]>,
  attached: string,
  scratch?: string,
): string[] {
  return [dirs.cwd, dirs.worktrees, dirs.locations, attached, ...(scratch ? [scratch] : [])].map(
    realOrSame,
  );
}

/**
 * Pick cwd, extra dirs, session and guard paths.
 * cwd: an explicit `resume` keeps its own; a background role works in the pinned location, else the sole location, else the
 * first registry location (the rest are `additionalDirectories`); a foreground role keeps the thread's stored cwd when it
 * is still valid, else the pinned location, the sole location, or the neutral workspace dir over several locations. Claude sessions
 * are keyed by cwd, so a session is resumed only when its cwd is the run's.
 * A role with the `write` capability may write in every location of the workspace, the worktrees dir, the task scratch
 * dir and the SDK plans dir; any other role may read only the registered locations (+ the workspace dirs).
 * Throws when a dir of a writing role is gone (the caller turns it into a failed result).
 */
export function roleScope(config: AgentConfig, i: RoleRunInput, role: RoleDefinition): RoleScope {
  if (i.workspace === undefined) return controlScope(config, i); // no workspace: the control channel
  const { locations, pinned } = i;
  const dirs = workspacePaths(config.agentHome).workspace(i.workspace);
  mkdirSync(dirs.cwd, { recursive: true });
  const scope = pinned ? [pinned] : locations;
  let cwd: string;
  let sessionId: string | undefined;
  if (i.resume) {
    // A background role resumes only inside a registered location or the workspace's neutral `cwd/` (a zero-location
    // workspace works there); an old session whose cwd was a plan scratch dir must not run as developer.
    const resumeCwd = realOrSame(i.resume.cwd);
    if (
      role.background &&
      resumeCwd !== realOrSame(dirs.cwd) &&
      !locations.some((r) => realOrSame(r.path) === resumeCwd)
    )
      throw new Error("resume cwd is not a workspace location");
    cwd = i.resume.cwd;
    sessionId = i.resume.sessionId;
  } else if (role.background) {
    // A background role that cannot write (a scout) works in the neutral dir and reads the locations as extra dirs.
    cwd =
      pinned?.path ??
      (role.capabilities.includes("write") ? (locations[0]?.path ?? dirs.cwd) : dirs.cwd);
  } else {
    const stored = i.existing;
    const storedOk =
      stored && (stored.cwd === dirs.cwd || locations.some((r) => r.path === stored.cwd));
    cwd =
      pinned?.path ??
      (storedOk ? stored.cwd : locations.length > 1 ? dirs.cwd : (locations[0]?.path ?? dirs.cwd));
    if (stored && stored.cwd === cwd) sessionId = stored.session_id;
  }
  const others = pinned ? [] : locations.map((r) => r.path).filter((p) => p !== cwd);
  if (!role.capabilities.includes("write")) {
    // Full text of a long owner attachment (saved by ingress, read-only): readable only when this thread has one.
    const attached = workspacePaths(config.agentHome).attachments(i.threadId);
    const additionalDirectories = [...others, ...(existsSync(attached) ? [attached] : [])];
    return {
      cwd,
      additionalDirectories,
      scope,
      sessionId,
      guard: {
        cwd: realOrSame(cwd),
        readPaths: [cwd, ...additionalDirectories].map(realOrSame),
        denyPaths: [realOrSame(config.agentHome)],
        allowInside: grantedUnderHome(dirs, attached),
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
  const locationName = locations.find((r) => realOrSame(r.path) === real.cwd)?.name;
  return {
    cwd: real.cwd,
    additionalDirectories: [...others, real.scratch, real.worktrees],
    scope,
    sessionId,
    worktreesDir: locationName ? join(real.worktrees, locationName) : undefined,
    guard: {
      cwd: real.cwd,
      writePaths: [
        ...new Set([
          real.cwd,
          ...locations.map((r) => realOrSame(r.path)),
          real.worktrees,
          real.scratch,
          claudePlansDir(),
        ]),
      ],
      worktreeDirs: [real.worktrees],
      denyPaths: [realOrSame(config.agentHome)],
      allowInside: grantedUnderHome(
        dirs,
        workspacePaths(config.agentHome).attachments(i.threadId),
        real.scratch,
      ),
    },
  };
}
