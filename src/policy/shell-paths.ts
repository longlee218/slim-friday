import { isAbsolute, resolve } from "node:path";
import type { GuardrailContext } from "./check-tool-call";
import { isInside, realOrSame, resolveReal } from "./paths";

/* Path operands of the worker shell: a plain word, no `..`, resolved (symlinks and case included) inside the dirs granted to the
   run (a granted dir is fully readable and writable, `.git` included). `/tmp` is not a root: the run's scratch dir (the goal dir under the agent home) is. Pure. */

/** The only chars of a path operand (a glob, `~` or `$` cannot get here: the shape gate refused them already). */
const PATH_WORD = /^[A-Za-z0-9_./-]+$/;

/** Real dirs the run may write: its write dirs (locations, scratch, plans), worktrees and goal dir. */
export function writeRoots(
  ctx: Pick<GuardrailContext, "writePaths" | "worktreeDirs" | "envelope">,
): string[] {
  const dirs = [...(ctx.writePaths ?? []), ...(ctx.worktreeDirs ?? []), ctx.envelope?.goalDir];
  return [...new Set(dirs.filter((d): d is string => !!d).map(realOrSame))];
}

/** Real dirs the run may read: the write dirs, the read paths, granted dirs under the agent home (skills) and the cwd. */
export function readRoots(ctx: GuardrailContext): string[] {
  const dirs = [...(ctx.readPaths ?? []), ...(ctx.allowInside ?? []), ctx.cwd];
  return [
    ...new Set([...writeRoots(ctx), ...dirs.filter((d): d is string => !!d).map(realOrSame)]),
  ];
}

/** True when `abs` (resolved through symlinks) lies in one of `roots`. */
function granted(abs: string, roots: string[]): boolean {
  let real: string;
  try {
    real = resolveReal(abs);
  } catch {
    return false; // a dangling symlink could point anywhere
  }
  return roots.some((r) => isInside(r, real));
}

/** True when the run's cwd lies in `roots`. */
export const cwdGranted = (ctx: GuardrailContext, roots: string[]): boolean =>
  !!ctx.cwd && granted(ctx.cwd, roots);

/** True when the path operand `w` is a plain path word without a `..` segment that resolves inside `roots`. */
export function pathGranted(w: string, ctx: GuardrailContext, roots: string[]): boolean {
  if (w === "/dev/null") return true;
  if (!PATH_WORD.test(w) || w.split("/").includes("..")) return false;
  if (!isAbsolute(w) && !ctx.cwd) return false;
  const abs = isAbsolute(w) ? w : resolve(ctx.cwd as string, w);
  return granted(abs, roots);
}
