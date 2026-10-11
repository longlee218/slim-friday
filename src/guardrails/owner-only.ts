/*
 * Owner-only asks: guard `ask` decisions that must reach the owner even in SDK auto mode (the classifier only
 * decides SOFT asks). The whole list lives here as data + one helper; the policy marks its asks with `ownerAsk`.
 * Owner-only kinds: env-override prefixes, output redirection leaving writePaths, `~` / `$HOME` expansion,
 * network commands (marked in checkNetwork), running a shell script, commands that cannot be parsed, indirect
 * launchers (`xargs`, `find -exec`) and `$(..)` / backtick substitution.
 */
import { isAbsolute, resolve } from "node:path";
import type { Decision } from "./check-tool-call";
import { isInside, realOrSame } from "./paths";

/** Env assignments that change which code runs or where it connects. */
export const OWNER_ONLY_ENV = /^(PATH|LD_\w+|DYLD_\w+|GIT_\w+|NODE_OPTIONS|BASH_ENV)=/;

/** A word that expands to the home dir (`~`, `~/x`, `$HOME`, `${HOME}`). */
export const HOME_REF = /^~|\$\{?HOME\b/;

/** `$(...)` or backtick substitution: can launch any command indirectly. */
export const SUBSTITUTION = /\$\(|`/;

/** Indirect launchers: `xargs`, and `find` options that run a command. */
export const INDIRECT_LAUNCHERS = new Set(["xargs"]);
export const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** An `ask` the classifier must not decide. */
export const ownerAsk = (reason: string): Decision => ({
  decision: "ask",
  reason,
  ownerOnly: true,
});

/**
 * True when a redirecting command may write outside `writePaths`. The redirect target is not parsed apart from
 * the other words, so every non-flag argument is judged as a possible target (conservative).
 */
export function redirectLeavesWritePaths(
  words: string[],
  cwd: string | undefined,
  writePaths: string[],
): boolean {
  if (!cwd) return true;
  const roots = writePaths.map(realOrSame);
  return words
    .slice(1)
    .filter((w) => !w.startsWith("-"))
    .some((w) => {
      if (HOME_REF.test(w)) return true;
      const abs = realOrSame(isAbsolute(w) ? w : resolve(cwd, w));
      return !roots.some((r) => isInside(r, abs));
    });
}
