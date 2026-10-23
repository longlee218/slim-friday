import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readProcessEnv } from "../config/process-env";
import { SECRET_HOME } from "../config/sensitive-paths";
import { workspacePaths } from "../config/workspace-paths";
import { spawnRunner } from "../locations/git-run";
import { isGitLocation, real } from "../locations/location-registry";
import type { Runner } from "../policy/effect-context";
import { isInside, realOrSame } from "../policy/paths";
import { loadWorkspaces } from "./workspace-registry";

/* New project from chat (`register_location` with `create: true`): CODE makes the directory, `git init`, a README with the
   request and the first commit under the owner's git identity. No agent shell is involved. Every guard returns a coded
   refusal that names the fix. The caller (teammate-location-handler) has already checked owner run, path-in-text and one-per-run. */

/** Longest request text written into the README. */
const README_REQUEST_CHARS = 4000;

/** A created project, or a coded refusal. */
export type CreateProjectResult =
  | { ok: true; path: string; made: boolean }
  | { ok: false; code: string; reason: string };

const fail = (code: string, reason: string): CreateProjectResult => ({ ok: false, code, reason });

/** True when git can commit: a name and an email from the owner's config (or the env switches). */
async function hasGitIdentity(cwd: string, run: Runner): Promise<boolean> {
  const env = readProcessEnv();
  if (env.GIT_AUTHOR_NAME && env.GIT_AUTHOR_EMAIL) return true;
  const [name, email] = await Promise.all([
    run(["git", "config", "user.name"], cwd),
    run(["git", "config", "user.email"], cwd),
  ]);
  return name.code === 0 && email.code === 0 && !!name.out && !!email.out;
}

/** The refusal for the final path component itself (lstat: a symlink, even a dangling one, is never followed), or undefined. */
function finalGuard(final: string): CreateProjectResult | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(final);
  } catch {
    return undefined; // nothing there: this call makes it
  }
  if (st.isSymbolicLink())
    return fail("PATH_IS_SYMLINK", "The path is a symlink: ask for a path that is not one.");
  if (!st.isDirectory() || readdirSync(final).length)
    return fail("PATH_EXISTS", "The path exists and is not an empty folder: ask for a new name.");
  return undefined;
}

/** Names this call writes into a dir it did not make: removed again on a rollback (the dir itself stays). */
const WRITTEN = ["README.md", String.fromCharCode(46) + "git"];

/**
 * Undo `createProject`: remove the dir when this call made it, else only the files this call wrote, so an owner's
 * pre-existing empty folder stays. Never throws.
 */
export function undoCreateProject(path: string, made: boolean): void {
  try {
    if (made) rmSync(path, { recursive: true, force: true });
    else for (const n of WRITTEN) rmSync(join(path, n), { recursive: true, force: true });
  } catch {
    // best effort: a leftover file is harmless and the refusal already names the failure
  }
}

/** The first guard that fails for `target` (absolute, parent resolved), or undefined. Pure checks, no side effect. */
function pathGuard(
  target: string,
  home: string,
  userHome: string,
): CreateProjectResult | undefined {
  const parent = dirname(target);
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    return fail(
      "PARENT_MISSING",
      `The parent dir ${parent} does not exist: ask for a path under an existing folder.`,
    );
  const realParent = realOrSame(parent);
  const final = join(realParent, basename(target));
  // The agent's `projects/` folder is the one exempt part of AGENT_HOME: a project strictly inside it (never the dir itself).
  const projectsRoot = realOrSame(workspacePaths(home).projects);
  const inAgentProjects = final !== projectsRoot && isInside(projectsRoot, final);
  // The agent's own projects folder needs no home check (AGENT_HOME may sit outside the owner's home).
  if (
    !inAgentProjects &&
    (final === realOrSame(userHome) || !isInside(realOrSame(userHome), final))
  )
    return fail(
      "OUTSIDE_HOME",
      `A new project must be a folder under the owner's home (${userHome}): ask for another path, e.g. ${join(userHome, "projects", basename(target))}.`,
    );
  if (!inAgentProjects && (isInside(realOrSame(home), final) || isInside(final, realOrSame(home))))
    return fail(
      "INSIDE_AGENT_HOME",
      "That path touches the agent's own home: ask for another path.",
    );
  if (SECRET_HOME.some((n) => isInside(realOrSame(join(userHome, n)), final)))
    return fail("CREDENTIAL_DIR", "That path is a credential folder: ask for another path.");
  const refusedFinal = finalGuard(final);
  if (refusedFinal) return refusedFinal;
  // Inside a git working tree: any ancestor holding .git.
  for (let d = realParent; ; d = dirname(d)) {
    if (isGitLocation(d))
      return fail("INSIDE_GIT_REPO", `${d} is a git repo: ask for a path outside it.`);
    if (dirname(d) === d) break;
  }
  const clash = loadWorkspaces(home, userHome).workspaces.flatMap((w) =>
    w.locations.filter(
      // A location that IS the owner's home holds every path under it (owner accepted that), so it cannot block a new
      // project under home: only a location inside the new path, or a narrower location around it, clashes.
      (l) =>
        (real(l.path) !== realOrSame(userHome) && isInside(real(l.path), final)) ||
        isInside(final, real(l.path)),
    ),
  )[0];
  if (clash)
    return fail(
      "INSIDE_LOCATION",
      `The path overlaps the location "${clash.name}": ask for another path.`,
    );
  return undefined;
}

/**
 * Create the project dir at `rawPath` (absolute or `~/...`): guards, mkdir, `git init`, README with `request`, first commit.
 * On a git failure the dir this call made is removed (a pre-existing empty dir is left). Never throws for expected failures.
 */
export async function createProject(
  home: string,
  userHome: string,
  rawPath: string,
  request: string,
  run: Runner = spawnRunner,
): Promise<CreateProjectResult> {
  const expanded = rawPath.startsWith("~/") ? join(userHome, rawPath.slice(2)) : rawPath;
  if (!isAbsolute(expanded) || rawPath.includes("\0"))
    return fail("BAD_PATH", "The path must be absolute or start with ~/.");
  const target = resolve(expanded);
  const refused = pathGuard(target, home, userHome);
  if (refused) return refused;
  const path = join(realOrSame(dirname(target)), basename(target));
  if (!(await hasGitIdentity(dirname(path), run)))
    return fail(
      "NO_GIT_IDENTITY",
      "No git user.name / user.email is configured: the owner sets them once (git config --global), then retry.",
    );
  let made = false;
  try {
    // Re-check right before writing: the path may have changed since the guard.
    const again = finalGuard(path);
    if (again) return again;
    try {
      mkdirSync(path); // not recursive: EEXIST = somebody else made it meanwhile
      made = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // The empty dir the guard accepted (the owner's) is used as is and never removed; anything else is a race.
      if (finalGuard(path))
        return fail("PATH_EXISTS", "The path appeared meanwhile: ask for a new name.");
    }
    writeFileSync(
      join(path, "README.md"),
      `# ${basename(path)}\n\n${request.slice(0, README_REQUEST_CHARS)}\n`,
      { flag: "wx" },
    );
    for (const cmd of [
      ["git", "init", "-b", "main"],
      ["git", "add", "README.md"],
      ["git", "commit", "-m", "Initial commit"],
    ]) {
      const r = await run(cmd, path);
      if (r.code !== 0) throw new Error(`${cmd[1]} failed: ${r.out.split("\n")[0]}`);
    }
    return { ok: true, path, made };
  } catch (err) {
    undoCreateProject(path, made); // only what this call made or wrote
    return fail("CREATE_FAILED", err instanceof Error ? err.message : String(err));
  }
}
