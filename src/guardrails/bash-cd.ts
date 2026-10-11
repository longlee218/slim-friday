import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isGitDirArg } from "./git-dir-guard";
import { isInside, resolveReal } from "./paths";

/* `cd <dir>` in a Bash line: harmless when <dir> stays inside the allowed dirs (models prefix commands with it).
   `cd` changes nothing itself; the line tracks the new cwd so later relative paths resolve against it, and a cd into
   a dir that is only READABLE makes every later segment read-only (see checkBash). */

/** What an allowed `cd` leaves behind. */
export interface CdState {
  /** Real path of the new cwd; undefined when the guard does not know its own cwd (a relative `cd` then). */
  cwd?: string;
  /** The target is inside a read path but no write path: only git reads and read commands may follow. */
  readOnly: boolean;
}

/** The state after `cd <dir>`, or undefined when it is not an allowed cd (then it is judged as a normal segment: ask). */
export function checkCd(
  words: string[],
  cwd: string | undefined,
  writeRoots: string[],
  readRoots: string[],
): CdState | undefined {
  if (words[0] !== "cd" || words.length !== 2) return undefined;
  const target = words[1] as string;
  // `cd -` (previous dir), `cd $HOME` / `$(..)` (not expanded by the parser), `~`, and `.git` (`cd .git` then a write).
  if (/^[-~]|[$`]/.test(target) || isGitDirArg(target)) return undefined;
  if (!isAbsolute(target) && /(^|[\\/])\.\.([\\/]|$)/.test(target)) return undefined;
  // A relative target without a known cwd is allowed as before (no `..`); the cwd then stays unknown.
  if (!isAbsolute(target) && !cwd) return { readOnly: false };
  let real: string;
  try {
    real = resolveReal(isAbsolute(target) ? target : join(cwd as string, target));
  } catch {
    return undefined;
  }
  // The real `cd` fails on a missing target and the shell keeps its cwd: the guard must not move on without it.
  try {
    if (!statSync(real).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const writable = writeRoots.some((r) => isInside(r, real));
  if (!writable && !readRoots.some((r) => isInside(r, real))) return undefined;
  return { cwd: real, readOnly: !writable };
}
