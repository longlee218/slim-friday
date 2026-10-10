/* Best-effort guard on a clone's `.git` directory (hooks, config): it may be read, never written, because
   a planted hook would run code in later app git calls. The hard barriers are `checkGit` (read-only git)
   and the Write/Edit deny of `.git` paths. */

/** An argument naming a `.git` path segment (`.git`, `.git/config`, `a/.git/hooks`). */
const GIT_DIR_ARG = /(^|[\\/=])\.git([\\/]|$)/;
/** Commands that only read: they may name a `.git` path (without a redirect). `git` itself is judged by `checkGit`. */
const GIT_DIR_READERS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "grep",
  "rg",
  "wc",
  "git",
]);

/** True when `arg` names a `.git` path segment. */
export const isGitDirArg = (arg: string): boolean => GIT_DIR_ARG.test(arg);

/** True when a command would write to a `.git` dir: it names one and is not a plain reader (or redirects). */
export const writesGitDir = (cmd: string, args: string[], redirect: boolean): boolean =>
  args.some(isGitDirArg) && (redirect || !GIT_DIR_READERS.has(cmd));
