import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Test-only: run a command and collect its result (fixtures are built with the plain git CLI). */
export async function runCmd(
  cmd: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** Run git, asserting success. */
export async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await runCmd(["git", ...args], cwd);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** Temp repo with one commit on `branch`; optionally with a bare origin that has it pushed. */
export async function makeRepo(branch = "main", withOrigin = false) {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  const repo = join(root, "repo");
  await g(root, "init", "-q", "-b", branch, repo);
  await g(repo, "config", "user.email", "t@t.t");
  await g(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  await g(repo, "add", "-A");
  await g(repo, "commit", "-qm", "init");
  let origin = "";
  if (withOrigin) {
    origin = join(root, "origin.git");
    await g(root, "init", "-q", "--bare", "-b", branch, origin);
    await g(repo, "remote", "add", "origin", origin);
    await g(repo, "push", "-q", "-u", "origin", branch);
  }
  return { root, repo, origin, wts: join(root, "wts") };
}

/** Test-only: the P2 clone fields of a `WorktreeRow` literal that predates them (an old git-worktree row). */
export const LEGACY_WT_FIELDS = {
  workspace: null,
  baseSha: null,
  originUrl: null,
  delivery: null,
  status: "active",
  patchPath: null,
  deliveredAt: null,
} as const;
