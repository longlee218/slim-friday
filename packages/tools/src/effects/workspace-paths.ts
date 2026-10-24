import { type Dirent, lstatSync, readdirSync, realpathSync } from "node:fs";
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
  // A link would be followed to its target: refuse it, the caller names the real path instead.
  try {
    if (lstatSync(path).isSymbolicLink()) return `is a link (name its target instead): ${path}`;
  } catch {
    // Missing: resolveReal below decides.
  }
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

/** Most entries one dir check walks; a bigger tree is refused rather than half checked. */
const MAX_WALK = 10_000;

/**
 * Why the dir `real` must not be moved as a whole: it holds a git dir or a sensitive file at any depth, or it is too
 * big to check. Undefined when it is safe (or not a dir). Links are not followed.
 */
export function protectedInside(
  real: string,
  isSensitive: (real: string) => boolean,
): string | undefined {
  let entries: Dirent[];
  try {
    if (!lstatSync(real).isDirectory()) return undefined;
    entries = readdirSync(real, { withFileTypes: true, recursive: true });
  } catch {
    return `cannot read: ${real}`;
  }
  if (entries.length > MAX_WALK) return `too many files to check: ${real}`;
  for (const e of entries) {
    const p = join(e.parentPath, e.name);
    if (e.name === GIT_DIR) return `holds a git dir: ${p}`;
    if (isSensitive(p)) return `holds a protected file: ${p}`;
  }
  return undefined;
}
