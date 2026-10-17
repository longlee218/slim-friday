import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A path segment that cannot climb out of its dir (ids and keys may come from model output). */
export const pathSegment = (s: string): string =>
  s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";

/**
 * Write `content` as `<dir>/<name>` (dir 0700, file 0600): the owner-only write of everything the agent stores outside a
 * repo. The dir is refused when it is a symlink (the write would go elsewhere). The file goes through a temp file (exclusive
 * name) and a rename: the rename replaces a symlink planted at the target instead of following it. Returns the path.
 */
export function writeFileAtomic(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`dir is a symlink: ${dir}`);
  const path = join(dir, name);
  const tmp = join(dir, `.${pathSegment(name)}.${crypto.randomUUID()}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
  return path;
}
