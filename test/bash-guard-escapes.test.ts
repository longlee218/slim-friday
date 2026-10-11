import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";

/* Re-review escapes of the widened Bash guard (Rev 12 E): cwd drift through a failed / piped / skipped `cd`,
   option values the path check never saw, recursion into secret files, option abbreviations. Everything asks. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "escapes-")));
const repo = join(base, "repo");
const ro = join(base, "ro");
const outside = join(base, "outside");
for (const dir of [repo, ro, outside, join(repo, "sub")]) mkdirSync(dir, { recursive: true });
for (const [dir, name] of [
  [repo, "a.txt"],
  [repo, ".env"],
  [repo, "id_rsa"],
  [repo, "list0"],
  [ro, "r.txt"],
  [outside, "hosts"],
] as const)
  writeFileSync(join(dir, name), "x\n");
writeFileSync(join(repo, "sub", "b.txt"), "b\n");
symlinkSync(outside, join(repo, "link"));

const ctx = { cwd: repo, writePaths: [repo], readPaths: [ro] };
const d = (command: string) => checkToolCall(BASH_TOOL_NAME, { command }, ctx).decision;
const ask = (...cmds: string[]) => {
  for (const c of cmds) expect([c, d(c) === "allow"]).toEqual([c, false]); // ask, or deny for a secret
};

test("H1: a cd to a missing dir does not move the guard cwd (the real cd fails)", () => {
  ask("cd missing; cat ../hosts", "cd missing && cat ../hosts", "cd missing || cat ../hosts");
  ask(`cd ${join(repo, "n1", "n2")}; cat ../../../outside/hosts`);
  ask("cd a.txt; cat b.txt"); // not a directory
});

test("H2: a cd inside a pipe, background, subshell, `||` or after a skippable command is not tracked", () => {
  ask(
    "ls | cd sub; cat ../../ro/r.txt",
    "cat a.txt | cd sub; cat b.txt",
    "cd sub & cat b.txt",
    "(cd sub); cat b.txt",
    "(cd sub; cat b.txt)",
    "cd sub || cat b.txt",
    "ls missing && cd sub; cat b.txt",
  );
  // a plain `cd` first and `;`-joined, or after `;`, still works
  expect(d("cd sub && cat b.txt")).toBe("allow");
  expect(d("cd sub; cat b.txt")).toBe("allow");
  expect(d("ls; cd sub; cat b.txt")).toBe("allow");
  expect(d("cd sub && cd .. && cat a.txt")).toBe("ask"); // `..` targets ask
});

test("M3: option values and long options that name files are not on the allowlist", () => {
  ask(
    "grep --file=.env a.txt",
    "grep --file=/etc/passwd a.txt",
    "grep -f/etc/passwd a.txt",
    "grep --exclude-from=.env x a.txt",
    "rg --file=/etc/passwd a.txt",
    "rg --ignore-file=/etc/passwd x a.txt",
    "sort --files0-from=list0",
    "wc --files0-from=list0",
    "du --files0-from=list0",
    "find . -files0-from list0",
    "sort --out=/tmp/zz a.txt",
    "sort --outp=/tmp/zz a.txt",
    "sort -o/tmp/zz a.txt",
    "sort --output x a.txt",
    "file --compile a.txt",
    "file -f list0",
    "tail -f a.txt",
    "tail -F a.txt",
    "ls --ignore=x",
    "find . -newerXY a.txt",
    "find . -newer a.txt",
  );
});

test("M3: sed is exactly `sed -n <N|N,M|$>p files`", () => {
  expect(d("sed -n 1,3p a.txt")).toBe("allow");
  ask(
    "sed -n 1p -i a.txt",
    "sed -n 1p --in-place a.txt",
    "sed -n 1p -f evil.sed a.txt",
    "sed -n 1p -e w a.txt",
    "sed -n -e 1p a.txt",
    "sed -i 1p a.txt",
    "sed -n 1p a.txt --expression=w",
  );
});

test("M4: recursive content tools and symlink followers ask (the Grep tool does recursive search)", () => {
  ask(
    "grep -r SECRET .",
    "grep -R SECRET .",
    "grep -rn SECRET",
    "grep --recursive SECRET .",
    "grep -d recurse SECRET .",
    "grep --directories=recurse SECRET .",
    "rg SECRET .",
    "rg SECRET",
    "rg SECRET sub",
    "rg --hidden SECRET a.txt",
    "rg -u SECRET a.txt",
    "rg -uu SECRET a.txt",
    "rg -L SECRET a.txt",
    "find -L . -name x",
    "find . -follow",
    "ls -L",
    "tree -l",
  );
  expect(d("rg alpha a.txt")).toBe("allow"); // an explicit plain file
  expect(d("grep -n x a.txt")).toBe("allow");
  expect(d("ls -R sub")).toBe("allow"); // names only
  expect(d("du -sh sub")).toBe("allow");
  expect(d("find . -name b.txt")).toBe("allow");
  expect(d("tree sub")).toBe("allow");
});

test("flag allowlist: bundles, numbers and values still work", () => {
  for (const c of [
    "ls -la sub",
    "ls -1A",
    "head -5 a.txt",
    "head -n 5 a.txt",
    "tail -n5 a.txt",
    "grep -A 3 -n x a.txt",
    "grep -e x a.txt",
    "sort -k2 -t, -rn a.txt",
    "cut -d, -f1 a.txt",
    "wc -l a.txt",
  ])
    expect([c, d(c)]).toEqual([c, "allow"]);
});

test("git reads: exact long options only (no unique-prefix abbreviations), no orderfile", () => {
  ask(
    "git diff --out=/tmp/x",
    "git log -p --ext-di",
    "git diff --ext-diff",
    "git log --textconv",
    "git diff --output=x",
    "git diff -O/etc/passwd",
    "cat a.txt | git log --ext-di",
  );
  expect(d("git log --oneline --stat -n 5")).toBe("allow");
  expect(d("git diff --cached --name-only")).toBe("allow");
  expect(d("git status --short --branch")).toBe("allow");
  expect(d("git log --format=oneline --max-count=3")).toBe("allow");
});

test("after a cd into a read-only dir the git reads are checked with the same allowlist", () => {
  ask(`cd ${ro} && git diff --out=x`, `cd ${ro}; git log --ext-di`, `cd ${ro} && bun install`);
  expect(d(`cd ${ro} && git status`)).toBe("allow");
});

test("re-review 2: heredocs cannot hide a cd (the line asks)", () => {
  ask(
    "cat <<ls\ncd sub\nls\ncat ../../ro/r.txt",
    "cat <<''\ncd sub\n\ncat ../a.txt",
    "cat <<-EOF\ncd sub\nEOF\ncat b.txt",
    "cat <<EOF\nx\nEOF",
  );
});

test("re-review 2: an expansion anywhere (flag values too) never runs without the owner", () => {
  ask(
    "head -n $TOK a.txt",
    'head -n "$TOK" a.txt',
    "head -n ${TOK} a.txt",
    "head -n ~ a.txt",
    "sort -t $TOK a.txt",
    "grep -A $TOK x a.txt",
    "cut -d $TOK -f1 a.txt",
    "tail -c $TOK a.txt",
    "git log --author=$(cat ../x); cd sub",
    "head -n $(cat ../a.txt) a.txt; cd sub",
    "head -n `cat ../a.txt` a.txt",
    "cat <(cat a.txt)",
    "head -n {1,2} a.txt",
    "git log --author=$TOK",
  );
  // a deny is never downgraded to ask by the expansion rule
  expect(d("sudo ls $HOME")).toBe("deny");
});

test("re-review 2: git global options and outside path operands ask", () => {
  ask(
    "git -C /etc status",
    `git -C ${outside} log -p`,
    "git --git-dir=/x diff",
    "git --work-tree=/etc status",
    "git --exec-path=/tmp/x status",
    "git -p log",
    "git --paginate log",
    "git --no-pager log",
    "git diff -- /etc/hosts",
    "git log -- ../outside/hosts",
    "git diff ../outside/hosts",
    `cd ${ro} && git -C /etc log`,
  );
  expect(d("git diff -- a.txt")).toBe("allow");
  expect(d("git log --oneline HEAD~1")).toBe("allow");
  expect(d("git diff HEAD -- sub/b.txt")).toBe("allow");
});

test("re-review 3: a backslash-newline (line continuation) cannot split a heredoc operator", () => {
  ask(
    "cat <\\\n<ls\ncd sub\nls\ncat ../../ro/r.txt",
    "cat <\\\n<\\\nls\ncd sub\nls\ncat ../../ro/r.txt",
    "cat a.txt \\\n b.txt",
  );
});
