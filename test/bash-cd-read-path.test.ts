import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";

/* Rev 12 E: `cd` into a registered repo (a READ path, as in the plan stage) is allowed; what runs after it is still
   judged per segment, so a write, a redirect or a git-dir target keeps asking / denying. */

const GIT_DIR = ".git";
const base = realpathSync(mkdtempSync(join(tmpdir(), "cdread-")));
const scratch = join(base, "scratch");
const repo = join(base, "repo");
const outside = join(base, "outside");
for (const d of [scratch, repo, outside, join(repo, GIT_DIR)]) mkdirSync(d, { recursive: true });
writeFileSync(join(repo, "PLAYBOOK.md"), "one\ntwo\n");
writeFileSync(join(repo, "a.ts"), "x\n");
mkdirSync(join(repo, "sub"));
symlinkSync(outside, join(repo, "sub", "escape")); // a symlink inside the repo that leads out of every root

// Plan stage shape: writes only in scratch; registered repos are read paths.
const ctx = { cwd: scratch, writePaths: [scratch], readPaths: [scratch, repo] };
const d = (command: string) => checkToolCall(BASH_TOOL_NAME, { command }, ctx).decision;

test("incident shape: cd into a read-path repo then read-only segments -> allow", () => {
  expect(d(`cd ${repo}`)).toBe("allow");
  expect(d(`cd ${repo} && git log --oneline -5 && git status`)).toBe("allow");
  expect(d(`cd ${repo} && git diff --stat`)).toBe("allow");
});

test("cd into a read path followed by a write or an unknown command keeps that decision", () => {
  expect(d(`cd ${repo} && rm x`)).toBe("ask");
  expect(d(`cd ${repo} && touch f`)).toBe("ask");
  expect(d(`cd ${repo} && git status && touch f`)).toBe("ask");
  expect(d(`cd ${repo} && git push`)).toBe("deny");
  expect(d(`cd ${repo} && rm -rf x`)).toBe("deny");
});

test("a redirect after the cd still asks", () => {
  expect(d(`cd ${repo} && git log > out.txt`)).toBe("ask");
  expect(d(`cd ${repo} && echo x > file`)).toBe("ask");
});

test("cd to home, a parent, a path outside the roots or a symlink out of them still asks", () => {
  expect(d("cd ~")).toBe("ask");
  expect(d("cd ../x")).toBe("ask");
  expect(d(`cd ${outside}`)).toBe("ask");
  expect(d(`cd ${join(repo, "sub", "escape")}`)).toBe("ask");
});

test("cd into a git dir is denied (judged as a segment, not as a cd)", () => {
  expect(d(`cd ${join(repo, GIT_DIR)}`)).toBe("deny");
  expect(d(`cd ${GIT_DIR}`)).toBe("deny");
  expect(d(`cd ${repo} && sed -i s/a/b/ ${GIT_DIR}/config`)).toBe("deny");
});

test("without readPaths nothing changes: the repo is not a write path", () => {
  const c = { writePaths: [scratch] };
  expect(checkToolCall(BASH_TOOL_NAME, { command: `cd ${repo}` }, c).decision).toBe("ask");
});

test("the incident line (read commands + git reads after a cd into the repo) -> allow", () => {
  expect(
    d(
      `cd ${repo} && ls -la && wc -l * && sed -n 1,40p PLAYBOOK.md && git log --oneline | head -5 && git status --short`,
    ),
  ).toBe("allow");
});

test("after a cd into a read-only dir only git reads and read commands may follow", () => {
  expect(d(`cd ${repo} && bun install --frozen-lockfile`)).toBe("ask");
  expect(d(`cd ${repo} && git diff --ext-diff`)).toBe("ask");
  expect(d(`cd ${repo} && git log --textconv`)).toBe("ask");
  expect(d(`cd ${repo} && curl https://github.com/x`)).toBe("ask");
  expect(d(`cd ${repo} && git status ; ls`)).toBe("allow");
});

test("cd targets that are not literal paths ask", () => {
  expect(d("cd -")).toBe("ask");
  expect(d("cd $HOME")).toBe("ask");
  expect(d(`cd ${repo} && cd -`)).toBe("ask");
});
