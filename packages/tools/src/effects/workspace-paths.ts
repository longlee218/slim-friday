import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The git dir name: nothing under it is ever touched by an effect tool. */
const GIT_DIR = ".git";

/** True when something exists at `p` (symlinks are not followed). */
function existsNoFollow(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `p` as a real absolute path: the nearest existing ancestor is realpath'd and the missing tail appended.
 * Throws on a dangling symlink (it could point anywhere). Copied from runtime-claude's floor (not importable here).
 */
export function resolveReal(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    let real: string | undefined;
    try {
      real = realpathSync.native(cur);
    } catch {
      real = undefined;
    }
    if (real !== undefined) return join(real, ...tail.reverse());
    if (existsNoFollow(cur)) throw new Error("dangling symlink or unreadable path");
    const parent = dirname(cur);
    if (parent === cur) throw new Error("no existing ancestor");
    tail.push(basename(cur));
    cur = parent;
  }
}

/** True when `target` is strictly under `root` (both real paths; the root itself is not inside). */
function strictlyInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Where an effect tool may act: `path` must be absolute, resolve (symlinks followed) strictly inside one of the
 * bot's workspaces, have no git dir segment and not be a sensitive file. Returns the real path and its workspace,
 * or the reason it is refused.
 */
export function checkInsideWorkspace(
  path: string,
  workspaces: string[],
  isSensitive: (real: string) => boolean,
): { real: string; workspace: string } | string {
  if (!isAbsolute(path)) return `not an absolute path: ${path}`;
  let real: string;
  try {
    real = resolveReal(path);
  } catch {
    return `cannot resolve: ${path}`;
  }
  for (const w of workspaces) {
    let root: string;
    try {
      root = resolveReal(w);
    } catch {
      continue;
    }
    if (!strictlyInside(root, real)) continue;
    if (relative(root, real).split(sep).includes(GIT_DIR)) return `inside the git dir: ${path}`;
    if (isSensitive(real)) return `protected file: ${path}`;
    return { real, workspace: root };
  }
  return `outside your workspaces (or a workspace root): ${path}`;
}
