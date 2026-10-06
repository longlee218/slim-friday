import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
 * Resolve `p` to a real absolute path. The nearest existing ancestor is realpath'd and the
 * missing tail is appended, so not-yet-created files resolve correctly.
 * Throws on dangling symlinks (could point anywhere) or when no ancestor resolves.
 */
export function resolveReal(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    let real: string | undefined;
    try {
      real = realpathSync(cur);
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

/** `resolveReal` that falls back to the input when it cannot be resolved. */
export function realOrSame(p: string): string {
  try {
    return resolveReal(p);
  } catch {
    return p;
  }
}

/** True when `target` equals or is nested under `root` (both already real paths). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
