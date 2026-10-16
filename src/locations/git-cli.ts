import { GIT_ISOLATED_ENV, gitIsolationArgs } from "./git-isolation";

/* Plain git CLI helper for the app's few git calls (location refresh). Argv only, no shell, so a
   branch or path never becomes shell syntax. Every call carries `GIT_HARDEN` (no hook, fsmonitor, ssh command, pager or `ext::` transport,
   whatever a repo's own config says) and the owner's global / system git config is switched off (git-isolation.ts): auth comes
   from the explicit credential helpers, not from files a worker could have planted. */

/**
 * Options of EVERY git subprocess the app runs. A worker may edit a location's `.git/config` and hooks (the location is trusted for
 * the worker), but these calls run OUTSIDE the sandbox with the bot's rights, so a `-c` (highest precedence) pins every repo-local
 * key that runs a program: hooks, fsmonitor, ssh command, pager, editor, askpass, external diff, gpg programs, `ext::` transport,
 * alternate-refs command. `credential.helper` is set explicitly by `gitIsolationArgs`. Known gap: `filter.*`, `merge.*.driver` and
 * `diff.*.textconv` drivers have arbitrary names, so a `.gitattributes` + config pair is not covered by a fixed key list.
 */
export const GIT_HARDEN: readonly string[] = [
  ...["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"],
  ...["-c", "core.sshCommand=ssh", "-c", "core.pager=cat", "-c", "core.editor=true"],
  ...["-c", "core.askPass=", "-c", "diff.external=", "-c", "protocol.ext.allow=never"],
  ...[
    "-c",
    "core.alternateRefsCommand=",
    "-c",
    "gpg.program=gpg",
    "-c",
    "gpg.ssh.program=ssh-keygen",
  ],
];

/** Hard stop of one git call. */
const GIT_TIMEOUT_MS = 120_000;

/** Result of one git call. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `git <args>` in `cwd` (a directory that exists). Never throws on a non-zero exit; see `gitOut`. */
async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...GIT_HARDEN, ...gitIsolationArgs(), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, ...GIT_ISOLATED_ENV, GIT_TERMINAL_PROMPT: "0" }, // never wait for a credential prompt
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** `runGit` that returns trimmed stdout and throws (message = first stderr line) on a non-zero exit. */
async function gitOut(args: string[], cwd: string): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    const line = r.stderr.trim().split("\n")[0] || `exit ${r.code}`;
    throw new Error(`git ${args[0]} failed: ${line}`);
  }
  return r.stdout.trim();
}
