import { linkSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInside, resolveReal } from "../policy/paths";

/** A path segment that cannot climb out of its dir (ids and keys may come from model output). */
export const pathSegment = (s: string): string =>
  s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";

/**
 * Refuse a `dir` that does not really live inside `home` (AGENT_HOME): a symlinked parent (`channels`, the workspace dir)
 * would send the write elsewhere. Checked BEFORE any mkdir, on the real path (the missing tail of a new dir is allowed).
 */
function assertInsideHome(home: string, dir: string): void {
  if (!isInside(resolveReal(home), resolveReal(dir)))
    throw new Error(`dir is outside AGENT_HOME: ${dir}`);
}

/**
 * Write `content` as `<dir>/<name>` (dir 0700, file 0600): the owner-only write of everything the agent stores outside a
 * repo. The dir is refused when its real path is outside `home` or when it is itself a symlink (the write would go elsewhere). The file goes through a temp file (exclusive
 * name) and a rename: the rename replaces a symlink planted at the target instead of following it. Returns the path.
 */
export function writeFileAtomic(home: string, dir: string, name: string, content: string): string {
  assertInsideHome(home, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`dir is a symlink: ${dir}`);
  const path = join(dir, name);
  const tmp = join(dir, `.${pathSegment(name)}.${crypto.randomUUID()}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
  return path;
}

/**
 * Like `writeFileAtomic`, but never replaces: the temp file is hard-linked to `<dir>/<name>` (the link fails when the name
 * exists, also for a name another save took a moment ago) and the temp name is removed. Returns the path, or null when
 * the name is taken (the caller picks another).
 */
export function writeFileExclusive(
  home: string,
  dir: string,
  name: string,
  content: string,
): string | null {
  assertInsideHome(home, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`dir is a symlink: ${dir}`);
  const path = join(dir, name);
  const tmp = join(dir, `.${pathSegment(name)}.${crypto.randomUUID()}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  try {
    linkSync(tmp, path);
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}
