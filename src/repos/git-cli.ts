/* Plain git CLI helper for the app's few git calls (repo refresh, legacy clone cleanup). Argv only, no shell, so a
   branch or path never becomes shell syntax. Not hardened on purpose (owner decision, Rev 7). */

/** Hard stop of one git call. */
export const GIT_TIMEOUT_MS = 120_000;

/** Result of one git call. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `git <args>` in `cwd` (a directory that exists). Never throws on a non-zero exit; see `gitOut`. */
export async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, // never wait for a credential prompt
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
export async function gitOut(args: string[], cwd: string): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    const line = r.stderr.trim().split("\n")[0] || `exit ${r.code}`;
    throw new Error(`git ${args[0]} failed: ${line}`);
  }
  return r.stdout.trim();
}
