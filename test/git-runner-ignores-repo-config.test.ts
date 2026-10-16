import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnRunner } from "../src/mcp/effects/git-run";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(() => {
  cleanupTmp();
  for (const k of Object.keys(IDENT)) delete process.env[k]; // the identity set below is this file's only
});

/* A worker may edit a location's git config and hooks. The app's own git calls (GitPush, MergeBranch: `spawnRunner`) run outside the
   sandbox, so a repo-local `core.sshCommand`, `core.fsmonitor` or `core.hooksPath` must never run. Local bare remote, no network. */

const root = tmpRoot("git-runner-config-");
const work = join(root, "work");
const bare = join(root, "remote.git");
const hooks = join(root, "hooks");
const marks = join(root, "marks");
for (const d of [work, hooks, marks]) mkdirSync(d, { recursive: true });

/** A marker script: running it leaves `marks/<name>`. */
function marker(path: string, name: string): string {
  writeFileSync(path, `#!/bin/sh\ntouch '${join(marks, name)}'\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}
const ran = (name: string) => existsSync(join(marks, name));
const clearMarks = () => {
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
};

const IDENT = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
// The runner keeps only the identity of the `GIT_*` env; set it for the whole file.
Object.assign(process.env, IDENT);

/** Plain git (no hardening) in `cwd`: the test's own setup and the control runs. */
function raw(args: string[], cwd = work) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

// A checkout with a bare remote, a diverged branch (for a real merge commit), then the planted config.
raw(["init", "-q", "--bare", bare], root);
raw(["init", "-q", "-b", "main"]);
raw(["commit", "-q", "--allow-empty", "-m", "base"]);
raw(["remote", "add", "origin", bare]);
raw(["push", "-q", "origin", "main"]);
raw(["checkout", "-q", "-b", "feat"]);
writeFileSync(join(work, "f.txt"), "f");
raw(["add", "f.txt"]);
raw(["commit", "-q", "-m", "feat"]);
raw(["checkout", "-q", "main"]);
raw(["commit", "-q", "--allow-empty", "-m", "main moves on"]);
for (const h of ["pre-commit", "pre-push", "pre-merge-commit", "post-merge", "post-commit"])
  marker(join(hooks, h), `hook-${h}`);
raw(["config", "core.hooksPath", hooks]);
raw(["config", "core.fsmonitor", marker(join(root, "fsm.sh"), "fsmonitor")]);
raw(["config", "core.sshCommand", marker(join(root, "ssh.sh"), "ssh")]);
raw(["config", "core.editor", marker(join(root, "ed.sh"), "editor")]);

test("control: the planted config does run under plain git (the test can detect a leak)", () => {
  raw(["status"]);
  raw(["commit", "-q", "--allow-empty", "-m", "c"]);
  raw(["ls-remote", "ssh://127.0.0.1:1/x"]);
  expect([ran("fsmonitor"), ran("hook-pre-commit"), ran("ssh")]).toEqual([true, true, true]);
  clearMarks();
});

test("the app git runner (GitPush / MergeBranch) never runs a repo-local fsmonitor, hook, ssh command or editor", async () => {
  const status = await spawnRunner(["git", "status"], work);
  const push = await spawnRunner(["git", "push", "origin", "main"], work);
  const merge = await spawnRunner(["git", "merge", "--no-ff", "feat", "-m", "m"], work);
  await spawnRunner(["git", "ls-remote", "ssh://127.0.0.1:1/x"], work);
  expect([status.code, push.code, merge.code]).toEqual([0, 0, 0]); // the calls still work
  for (const m of [
    "fsmonitor",
    "ssh",
    "editor",
    "hook-pre-push",
    "hook-pre-merge-commit",
    "hook-post-merge",
    "hook-post-commit",
  ])
    expect([m, ran(m)]).toEqual([m, false]);
});
