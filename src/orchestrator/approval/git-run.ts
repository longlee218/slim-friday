import { GIT_HARDEN } from "../../locations/git-cli";
import { GIT_ISOLATED_ENV, gitIsolationArgs } from "../../locations/git-isolation";
import { clip } from "../../observability/redact";
import type { Runner } from "./effect-context";

/* Shared bits of the git / gh effect tools: the process runner and name checks. */

/** Longest a git or gh call may run (ms). */
const TIMEOUT_MS = 120_000;

/** Git's own env switches that stay (the commit identity); every other `GIT_*` of the bot's env is dropped for git. */
const GIT_ENV_KEEP = new Set([
  ...["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"],
]);

/** The argv of a git call with the hardening and isolation options right after `git`; other programs are unchanged. */
export const hardenedArgv = (cmd: string[]): string[] =>
  cmd[0] === "git" ? ["git", ...GIT_HARDEN, ...gitIsolationArgs(), ...cmd.slice(1)] : cmd;

/**
 * Env of one subprocess. git gets none of the `GIT_*` switches (no `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_DIR` ...); `gh`
 * keeps the bot's env, so its token (GH_TOKEN) exists only inside this tool's own subprocess and never in a worker's shell.
 */
export function subprocessEnv(
  cmd: string[],
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  if (cmd[0] !== "git") return { ...source };
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([k]) => !k.startsWith("GIT_") || GIT_ENV_KEEP.has(k)),
    ),
    ...GIT_ISOLATED_ENV, // the owner's global / system git config never steers an app git call
  };
}

/** Runs an argv array (no shell) in `cwd`, output merged and clipped; a timeout kills it and fails the call. */
export const spawnRunner: Runner = async (cmd, cwd) => {
  const proc = Bun.spawn(hardenedArgv(cmd), {
    cwd,
    env: subprocessEnv(cmd),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out: clip(`${out}${err}`.trim(), 2000) };
  } finally {
    clearTimeout(timer);
  }
};

/** A plain branch or remote name: no leading dash (an option), no `..`, no `//`, no `.lock` end, no `+` (a force refspec). */
export const isPlainRef = (name: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name) &&
  !name.includes("..") &&
  !name.includes("//") &&
  !name.endsWith("/") &&
  !name.endsWith(".lock");
