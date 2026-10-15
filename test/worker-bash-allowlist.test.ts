import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardrailContext } from "../src/guardrails/check-tool-call";
import { classifyBash } from "../src/orchestrator/approval/bash-allowlist";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* The worker shell allowlist: every segment gets a class, unknown = R2, listed R2/R3 name their effect tool. */

const root = tmpRoot("allowlist-");
const loc = join(root, "loc");
mkdirSync(loc);
const ctx: GuardrailContext = { cwd: loc, writePaths: [loc], allowInside: [] };
const risk = (c: string, x: GuardrailContext = ctx) => classifyBash(c, x).risk;

test("read and write-local commands pass as R0 / R1; a line is ONE simple command", () => {
  expect(risk("ls -la")).toBe("R0");
  expect(risk("rg foo src")).toBe("R0");
  expect(risk("git status")).toBe("R0");
  expect(risk("git diff HEAD~1")).toBe("R0");
  expect(risk("git add -A")).toBe("R1");
  expect(risk("git commit -m x")).toBe("R1");
  expect(risk("bun test")).toBe("R1");
  expect(risk("mkdir out")).toBe("R1");
  // Compound lines are never parsed: unknown, denied unless granted.
  expect(risk("ls -la && rg foo src | wc -l")).toBe("R2");
  expect(risk("git status && git diff")).toBe("R2");
  expect(risk("FOO=1 ls")).toBe("R2"); // a VAR=value prefix is not stripped: unknown (it can set GIT_*, LESSOPEN ...)
});

test("a write command whose target is outside the work dirs, or cannot be resolved, is R2", () => {
  expect(risk("mkdir /etc/x")).toBe("R2");
  expect(risk("touch ../escape")).toBe("R2");
  expect(risk("touch /tmp/x")).toBe("R2"); // /tmp is not a root: only the run's own scratch dir is
  expect(risk("mv a $HOME/b")).toBe("R2");
  expect(risk("cd /etc && touch x")).toBe("R2"); // cd is not listed (the shell's cwd persists between calls)
  expect(risk(`touch ${loc}/x`)).toBe("R1");
  expect(risk("touch x", { ...ctx, cwd: "/etc" })).toBe("R2"); // the cwd itself must be granted
});

test("tricky forms are unknown (R2): sh -c, substitutions, scripts, xargs rm, redirects, find -delete", () => {
  for (const c of [
    "sh -c 'ls'",
    "bash -c ls",
    "echo $(whoami)",
    "echo `id`",
    "cat <(ls)",
    "./run.sh",
    "/bin/ls",
    "node x.js",
    "ls | xargs rm",
    "find . -delete",
    "find . -exec ls {} ;",
    "echo hi > out.txt",
    "sed -i s/a/b/ f",
    "echo 'unbalanced",
    "eval ls",
  ])
    expect(risk(c)).toBe("R2");
});

test("rm, git push, gh pr create and git merge are listed: R2 / R3 with the replacing tool", () => {
  expect(classifyBash("rm -rf node_modules", ctx)).toMatchObject({
    risk: "R2",
    use: "DeletePaths",
  });
  expect(classifyBash("git push origin feat", ctx)).toMatchObject({ risk: "R3", use: "GitPush" });
  expect(classifyBash("gh pr create --fill", ctx)).toMatchObject({
    risk: "R3",
    use: "CreatePullRequest",
  });
  expect(classifyBash("git merge feat", ctx)).toMatchObject({ risk: "R2", use: "MergeBranch" });
  expect(risk("git reset --hard HEAD~1")).toBe("R2");
  expect(risk("git branch -D x")).toBe("R2");
  expect(risk("git clean -fd")).toBe("R2");
  expect(risk("gh pr view 3")).toBe("R0");
  expect(risk("gh pr view -R other/repo")).toBe("R2");
});

test("a script in a granted read-only dir (a skill) runs; one in a writable dir never does", () => {
  const skill = join(root, "skill");
  mkdirSync(skill);
  const withSkill: GuardrailContext = { ...ctx, allowInside: [skill], skillDirs: [skill] };
  expect(risk(`${skill}/run.sh a`, withSkill)).toBe("R1");
  expect(risk(`bash ${skill}/run.sh a`, withSkill)).toBe("R1");
  expect(risk(`bash -c ${skill}/run.sh`, withSkill)).toBe("R2");
  expect(risk(`${loc}/own.sh`, { ...withSkill, allowInside: [loc, skill] })).toBe("R2");
});
