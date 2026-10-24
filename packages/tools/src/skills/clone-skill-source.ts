import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Refused } from "../design/design-util";
import { defaultGitRunner, type GitRunner } from "./git-runner";
import { parseSkillSource } from "./skill-source-url";

export type { GitRunner };
export { defaultGitRunner };

/** Largest clone (bytes of files, `.git` excluded) and file count the settings page accepts. */
export const CLONE_MAX_BYTES = 50 * 1024 * 1024;
export const CLONE_MAX_FILES = 5000;
/** Time one git call may run before it is killed. */
export const CLONE_TIMEOUT_MS = 60_000;

/**
 * Options of every clone call: https is the only transport, no hooks, no fsmonitor, no symlink checkout, no
 * credential helper, no redirects, no template. Deliberately NOT `GIT_HARDEN` (it adds the owner's keychain helper).
 */
export const CLONE_GIT_ARGS: readonly string[] = [
  ...["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"],
  ...["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.symlinks=false"],
  ...["-c", "credential.helper=", "-c", "http.followRedirects=false", "-c", "init.templateDir="],
  // A stalled transfer (under 1 KB/s for 20 s) aborts on its own.
  ...["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=20"],
];

/** The whole env of a clone: nothing of the engine's env except `PATH`, a throwaway HOME, no git config, no prompts. */
export function cloneEnv(tmpHome: string, pathEnv: string): Record<string, string> {
  return {
    PATH: pathEnv,
    HOME: tmpHome,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_PROTOCOL_FROM_USER: "0",
  };
}

/**
 * Count files and bytes of a clone without following symlinks (`lstat`): a symlink is one file and is not entered,
 * `.git` is skipped. Refuses as soon as a cap is passed.
 */
function checkCaps(root: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && e.name === ".git") continue;
      const p = join(dir, e.name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      files += 1;
      bytes += st.size;
      if (files > CLONE_MAX_FILES)
        throw new Refused(`The repo has more than ${CLONE_MAX_FILES} files.`, "source");
      if (bytes > CLONE_MAX_BYTES)
        throw new Refused(`The repo is larger than ${CLONE_MAX_BYTES / 1024 / 1024} MB.`, "source");
    }
  };
  walk(root);
}

/**
 * Size the tree from `git ls-tree -r -l` output (`<mode> <type> <sha> <size>\t<path>`) before anything is written:
 * every entry counts as a file and blob sizes are summed (a submodule or `-` size counts 0).
 */
function checkTree(listing: string): void {
  let files = 0;
  let bytes = 0;
  for (const line of listing.split("\n")) {
    if (!line.trim()) continue;
    files += 1;
    bytes += Number(line.slice(0, line.indexOf("\t")).trim().split(/\s+/)[3]) || 0;
    if (files > CLONE_MAX_FILES)
      throw new Refused(`The repo has more than ${CLONE_MAX_FILES} files.`, "source");
    if (bytes > CLONE_MAX_BYTES)
      throw new Refused(`The repo is larger than ${CLONE_MAX_BYTES / 1024 / 1024} MB.`, "source");
  }
}

/**
 * Shallow-clone an https repo into a fresh temp dir under `tmpRoot` and return its dir and HEAD sha. Any failure
 * (bad input, git error, over a cap) removes the temp dir before the error goes up; on success the caller calls
 * `cleanup()` when done with the files.
 */
export async function cloneSkillSource(
  source: string,
  opts: { path?: string; tmpRoot: string; pathEnv: string; run?: GitRunner },
): Promise<{ dir: string; sha: string; cleanup(): void }> {
  const { url } = parseSkillSource(source, opts.path);
  const run = opts.run ?? defaultGitRunner;
  const tmp = mkdtempSync(join(opts.tmpRoot, "clone-"));
  const cleanup = () => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort: never hide the error that made us clean up
    }
  };
  try {
    const dir = join(tmp, "repo");
    const env = cloneEnv(tmp, opts.pathEnv);
    const clone = await run(
      [
        "git",
        ...CLONE_GIT_ARGS,
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        "--no-checkout",
        "--no-recurse-submodules",
        "--template=",
        "--",
        url,
        dir,
      ],
      env,
      CLONE_TIMEOUT_MS,
    );
    if (clone.code !== 0) throw new Refused("git could not clone the source.", "source");
    const head = await run(
      ["git", ...CLONE_GIT_ARGS, "-C", dir, "rev-parse", "HEAD"],
      env,
      CLONE_TIMEOUT_MS,
    );
    if (head.code !== 0) throw new Refused("git could not read the clone.", "source");
    // Size the tree first, then write files; the walk after checkout is a second check.
    const tree = await run(
      ["git", ...CLONE_GIT_ARGS, "-C", dir, "ls-tree", "-r", "-l", "HEAD"],
      env,
      CLONE_TIMEOUT_MS,
    );
    if (tree.code !== 0) throw new Refused("git could not list the clone.", "source");
    checkTree(tree.out);
    const out = await run(
      ["git", ...CLONE_GIT_ARGS, "-C", dir, "checkout", "--quiet", "HEAD"],
      env,
      CLONE_TIMEOUT_MS,
    );
    if (out.code !== 0) throw new Refused("git could not check out the clone.", "source");
    checkCaps(dir);
    return { dir, sha: head.out.trim(), cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}
