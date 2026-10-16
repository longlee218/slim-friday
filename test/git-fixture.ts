import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Test-only: run a command and collect its result (fixtures are built with the plain git CLI). */
async function runCmd(
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

/** Temp location with one commit on `branch`; optionally with a bare origin that has it pushed. */
export async function makeLocation(branch = "main", withOrigin = false) {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  const location = join(root, "location");
  await g(root, "init", "-q", "-b", branch, location);
  await g(location, "config", "user.email", "t@t.t");
  await g(location, "config", "user.name", "t");
  writeFileSync(join(location, "a.txt"), "one\n");
  await g(location, "add", "-A");
  await g(location, "commit", "-qm", "init");
  let origin = "";
  if (withOrigin) {
    origin = join(root, "origin.git");
    await g(root, "init", "-q", "--bare", "-b", branch, origin);
    await g(location, "remote", "add", "origin", origin);
    await g(location, "push", "-q", "-u", "origin", branch);
  }
  return { root, location, origin };
}
