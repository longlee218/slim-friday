import { existsSync, mkdirSync, realpathSync } from "node:fs";
import type { AgentConfig } from "../../config/agent-config";
import { workspacePaths } from "../../config/workspace-paths";
import { logEvent, logger } from "../../observability/logger";
import { isInside, realOrSame } from "../../policy/paths";
import type { RoleDefinition } from "../../roles/role-types";
import { policyOf } from "../../tools/role-policy";
import type { RoleRunInput } from "./role-run-types";
import type { RoleScope } from "./role-scope-types";

/** Logger of this module. */
const log = logger.child({ module: "role-scope" });

/* Where a role run works and what it may touch, from role DATA (capabilities, kind) and the run input. */

/** Dirs of the run under AGENT_HOME that stay usable although AGENT_HOME is denied (guard `allowInside`). */
function grantedUnderHome(
  dirs: ReturnType<ReturnType<typeof workspacePaths>["workspace"]>,
  attached: string,
  projects: string,
  runLocations: string[],
  scratch?: string,
): string[] {
  // Only this run's locations inside `<home>/projects` (never the whole dir: a run must not read other projects).
  const root = realOrSame(projects);
  const ownProjects = runLocations.map(realOrSame).filter((p) => p !== root && isInside(root, p));
  return [dirs.cwd, dirs.locations, attached, ...(scratch ? [scratch] : []), ...ownProjects].map(
    realOrSame,
  );
}

/**
 * Pick cwd, extra dirs, session and guard paths.
 * cwd: an explicit `resume.cwd` keeps its own; a worker role (also one resumed without `resume.cwd`) works in the pinned
 * location, else the sole location, else the first registry location (the rest are `additionalDirectories`); a non-worker role keeps the thread's stored cwd when it
 * is still valid, else the pinned location, the sole location, or the neutral workspace dir over several locations. Claude sessions
 * are keyed by cwd, so a session is resumed only when its cwd is the run's.
 * A role with the `write` capability may write in every location of the workspace, the task scratch
 * dir and the SDK plans dir; any other role may read only the registered locations (+ the workspace dirs).
 * Throws when a dir of a writing role is gone (the caller turns it into a failed result).
 */
export function roleScope(config: AgentConfig, i: RoleRunInput, role: RoleDefinition): RoleScope {
  if (i.workspace === undefined) throw new Error("A run needs a workspace");
  const { locations, pinned } = i;
  const dirs = workspacePaths(config.agentHome).workspace(i.workspace);
  const projectsDir = workspacePaths(config.agentHome).projects;
  mkdirSync(dirs.cwd, { recursive: true });
  const scope = pinned ? [pinned] : locations;
  let cwd: string;
  let sessionId: string | undefined;
  if (i.resume?.cwd) {
    // A worker role resumes only inside a registered location or the workspace's neutral `cwd/` (a zero-location
    // workspace works there); an old session whose cwd was a plan scratch dir must not run as developer.
    const resumeCwd = realOrSame(i.resume.cwd);
    if (
      role.kind === "worker" &&
      resumeCwd !== realOrSame(dirs.cwd) &&
      !locations.some((r) => realOrSame(r.path) === resumeCwd)
    )
      throw new Error("resume cwd is not a workspace location");
    cwd = i.resume.cwd;
    sessionId = i.resume.sessionId;
  } else if (role.kind === "worker") {
    // A worker role that cannot write (a scout) works in the neutral dir and reads the locations as extra dirs.
    cwd = pinned?.path ?? (policyOf(role).write ? (locations[0]?.path ?? dirs.cwd) : dirs.cwd);
    sessionId = i.resume?.sessionId; // a resumed item: same computed cwd as its first run
  } else {
    const stored = i.existing;
    const storedOk =
      stored && (stored.cwd === dirs.cwd || locations.some((r) => r.path === stored.cwd));
    cwd =
      pinned?.path ??
      (storedOk ? stored.cwd : locations.length > 1 ? dirs.cwd : (locations[0]?.path ?? dirs.cwd));
    if (stored && stored.cwd === cwd) sessionId = stored.session_id;
    // The stored session was keyed by another cwd (locations changed): this run starts a fresh one. Say so.
    else if (stored && role.kind === "teammate")
      logEvent(log, "teammate.session_rollover", { threadId: i.threadId, reason: "cwd" });
  }
  const others = pinned ? [] : locations.map((r) => r.path).filter((p) => p !== cwd);
  const policy = policyOf(role);
  const attachments = workspacePaths(config.agentHome).attachments(i.threadId);
  // A teammate with a shell or a scratch-needing tool (browser) gets its own run dir even without the write capability.
  const ownScratch = role.kind === "teammate" && (policy.shell || policy.scratch);
  if (!policy.write) {
    // Full text of a long owner attachment (saved by ingress, read-only): readable only when this thread has one.
    const scratch = ownScratch ? makeScratch(config.agentHome, i.turnId) : undefined;
    const additionalDirectories = [
      ...others,
      ...(existsSync(attachments) ? [attachments] : []),
      ...(scratch ? [scratch] : []),
    ];
    return {
      cwd,
      additionalDirectories,
      scope,
      sessionId,
      guard: {
        cwd: realOrSame(cwd),
        readPaths: [cwd, ...additionalDirectories].map(realOrSame),
        denyPaths: [realOrSame(config.agentHome)],
        allowInside: grantedUnderHome(
          dirs,
          attachments,
          projectsDir,
          locations.map((r) => r.path),
          scratch,
        ),
        ...(scratch && { scratchDir: scratch }),
      },
    };
  }
  const real = { cwd: realpathSync(cwd), scratch: makeScratch(config.agentHome, i.turnId) };
  const writePaths = [
    ...new Set([real.cwd, ...locations.map((r) => realOrSame(r.path)), real.scratch]),
  ];
  const allowInside = grantedUnderHome(
    dirs,
    attachments,
    projectsDir,
    locations.map((r) => r.path),
    real.scratch,
  );
  return {
    cwd: real.cwd,
    additionalDirectories: [...others, real.scratch],
    scope,
    sessionId,
    guard: {
      cwd: real.cwd,
      writePaths,
      // A writing run reads only what it may write plus its own dirs: never ~/.ssh, ~/.aws ...
      readPaths: [...new Set([...writePaths, ...allowInside])],
      denyPaths: [realOrSame(config.agentHome)],
      allowInside,
      // A worker's scratch is its envelope's goal dir; a teammate's is the run dir.
      ...(role.kind !== "worker" && { scratchDir: real.scratch }),
    },
  };
}

/** The run's own scratch dir under AGENT_HOME (created, private), as a real path. */
function makeScratch(agentHome: string, turnId: string): string {
  const scratch = workspacePaths(agentHome).run(turnId);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  return realpathSync(scratch);
}
