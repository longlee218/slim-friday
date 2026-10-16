import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type { GuardrailContext } from "./check-tool-call";
import { isInside, realOrSame } from "./paths";

/* The few git rules a table row cannot say: they look at the disk (a word that is also a file) or at the run's dirs. Pure
   apart from `lstat`. Each returns the path operands the caller must still resolve inside the grants, or undefined = unknown. */

/** git subcommands whose operands may be revs (`HEAD~2`): the only ones where a dropped `~` / `^` suffix is accepted. */
const REV_SUBS = new Set(["show", "log", "diff", "rev-parse", "reset", "checkout", "switch"]);
/** A rev before the `:` of `REV:path` (`HEAD`, `main`, `v1.2`, `abc123`). */
const REV_PART = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** True when something exists at `word` (relative to `cwd`; a link is not followed): git would read it as a path, not a rev. */
function namesAFile(word: string, cwd: string): boolean {
  try {
    lstatSync(resolve(cwd, word));
    return true;
  } catch {
    return false;
  }
}

/** True when a git line with dropped rev suffixes (`revWords`) is fine: a rev subcommand and no suffixed word is a file. */
export function revWordsOk(words: string[], revWords: string[], cwd: string | undefined): boolean {
  if (revWords.length === 0) return true;
  if (words[0] !== "git" || !REV_SUBS.has(words[1]) || !cwd) return false;
  return !revWords.some((w) => namesAFile(w, cwd));
}

/**
 * Judge the path operands of a matched git line. `git show|diff REV:path` keeps only its path part (the rev part must be a plain
 * rev); `git checkout|switch <name>` refuses a name that is a file of the cwd; `git worktree add <dir> <branch>` needs `<dir>`
 * under a worktrees dir of the run. Anything else passes unchanged.
 */
export function gitPaths(
  words: string[],
  paths: string[],
  ctx: GuardrailContext,
): string[] | undefined {
  if (words[0] !== "git") return paths;
  const sub = words[1];
  if (sub === "show" || sub === "diff") {
    const out: string[] = [];
    for (const p of paths) {
      const at = p.indexOf(":");
      if (at < 0) out.push(p);
      else if (REV_PART.test(p.slice(0, at)) && p.length > at + 1) out.push(p.slice(at + 1));
      else return undefined;
    }
    return out;
  }
  if (sub === "checkout" || sub === "switch") {
    // `--` forces the path form (`checkout -- file` would discard edits): a branch switch never needs it.
    if (!ctx.cwd || words.includes("--")) return undefined;
    return paths.some((p) => namesAFile(p, ctx.cwd as string)) ? undefined : paths;
  }
  if (sub === "worktree" && words[2] === "add") {
    const dirs = (ctx.worktreeDirs ?? []).map(realOrSame);
    const dir = realOrSame(resolve(ctx.cwd ?? "/", paths[0] ?? ""));
    return paths.length === 1 && ctx.cwd && dirs.some((d) => isInside(d, dir)) ? paths : undefined;
  }
  return paths;
}
