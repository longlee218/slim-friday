import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall, type GuardrailContext } from "../src/policy/check-tool-call";

/* Phase 1g review fixes: a $HOME location must not reach AGENT_HOME (~/.friday) by search roots, bulk commands,
   globs, cd, ~user or git. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "friday-protected-")));
const home = join(base, "home");
const agent = join(home, ".friday");
const modules = join(home, "proj", "node_modules");
mkdirSync(modules, { recursive: true });
mkdirSync(join(agent, "data"), { recursive: true });
writeFileSync(join(agent, "data", "agent.db"), "x");
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ctx: GuardrailContext = {
  cwd: home,
  readPaths: [home],
  writePaths: [home],
  denyPaths: [agent],
  allowInside: [],
};
const run = (tool: string, input: Record<string, unknown>, c = ctx) =>
  checkToolCall(tool, input, c).decision;

/** Bash decision with HOME = the fake home (`~` / `$HOME` expansion follows it). */
function bash(command: string, c = ctx): string {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return run("Bash", { command }, c);
  } finally {
    process.env.HOME = prev;
  }
}

test("Glob/Grep: a search root containing the agent home is denied, whatever the pattern", () => {
  expect(run("Grep", { pattern: "x" })).toBe("deny");
  expect(run("Grep", { pattern: "x", path: "." })).toBe("deny");
  expect(run("Grep", { pattern: "x", path: home })).toBe("deny");
  expect(run("Grep", { pattern: "x", glob: ".friday/**" })).toBe("deny");
  expect(run("Glob", { pattern: ".friday/**" })).toBe("deny");
  expect(run("Glob", { pattern: "**/agent.db" })).toBe("deny");
  expect(run("Glob", { pattern: "*.ts", path: join(home, "proj") })).toBe("allow");
  expect(run("Grep", { pattern: "x", path: join(home, "proj") })).toBe("allow");
  // A root inside a granted dir stays usable.
  const own = join(agent, "data");
  expect(run("Grep", { pattern: "x" }, { ...ctx, cwd: own, allowInside: [own] })).toBe("allow");
});

test("Bash: bulk commands on a path above the agent home are denied", () => {
  for (const c of [
    `grep -r x ${home}`,
    "grep -R x .",
    "rg x ~",
    "find . -name agent.db",
    "find -name agent.db",
    "grep -r foo",
    `tar czf /tmp/a.tgz ${home}`,
    "zip -r /tmp/a.zip .",
    `rsync -a ${home}/ /tmp/b`,
    "cp -r . /tmp/b",
    "cp -a ~ /tmp/b",
    "du -sh .",
    "ls -R ~",
    "chmod -R u+r ..",
    "scp -r ~ host:/x",
  ])
    expect([c, bash(c)]).toEqual([c, "deny"]);
  for (const c of [
    "ls ~",
    "cat ~/proj/a.txt",
    `grep -r x ${home}/proj`,
    "find proj -name a",
    "cd ~",
  ])
    expect([c, bash(c)]).toEqual([c, "allow"]);
});

test("Bash: globs reaching the agent home, ~user", () => {
  for (const c of [
    "cat ~/.f*/data/agent.db",
    "ls .fri*/data/*",
    "cat .friday/d*/agent.db",
    "cat ~root/x",
    "ls ~root",
  ])
    expect([c, bash(c)]).toEqual([c, "deny"]);
  expect(bash("cat ~/pr*/a.txt")).toBe("allow");
  expect(bash("ls proj/*")).toBe("allow");
});

test("Bash: relative words follow a cd", () => {
  const inProj = { ...ctx, cwd: join(home, "proj") };
  expect(bash(`cd ${home} && cat .friday/data/agent.db`, inProj)).toBe("deny");
  expect(bash("cd .. && cat .friday/data/agent.db", inProj)).toBe("deny");
  expect(bash("cd ~ && ls .friday", { ...ctx, cwd: "/tmp" })).toBe("deny");
  // Non-static cd: a relative word that could reach it is denied, plain words are not.
  expect(bash('cd "$X" && cat .friday/data/agent.db')).toBe("deny");
  expect(bash('cd "$X" && cat ../.friday/data/agent.db')).toBe("deny");
  expect(bash('cd "$X" && bun test')).toBe("allow");
  expect(bash('cd "$X" && grep -r foo')).toBe("deny");
  // A subshell's cd ends with it.
  expect(bash("(cd proj && ls) && ls")).toBe("allow");
  expect(bash("(cd proj) && cat .friday/data/agent.db")).toBe("deny");
  expect(bash("cd proj && cat a.txt")).toBe("allow");
});

test("Bash git: init / add / -C / --git-dir above the agent home are denied; a repo in a subdir is not", () => {
  for (const c of [
    "git init",
    "git add .",
    "git add -A",
    `git -C ${home} add x`,
    `git -C ${home} status`,
    `git --git-dir=${home}/.git status`,
    `git --work-tree=${home} status`,
    `git --work-tree ${home} status`,
    `git init ${home}`,
  ])
    expect([c, bash(c)]).toEqual([c, "deny"]);
  const sub = { ...ctx, cwd: join(home, "proj") };
  for (const c of ["git init", "git add .", "git status", `git -C ${home}/proj add x`])
    expect([c, bash(c, sub)]).toEqual([c, "allow"]);
  expect(bash("git status")).toBe("allow");
  expect(bash("git log")).toBe("allow");
});

test("rm -r with ~ / $HOME forms follows the write paths", () => {
  expect(bash("rm -r ~/proj/node_modules")).toBe("allow");
  expect(bash("rm -r $HOME/proj/node_modules")).toBe("allow");
  expect(bash("rm -r ~/.friday/x")).toBe("deny");
  expect(bash("rm -r ~/other", { ...ctx, writePaths: [join(home, "proj")] })).toBe("deny");
  expect(modules).toContain("node_modules");
});
