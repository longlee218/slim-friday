import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";

/* Read-only shell commands pass without approval inside the roots; every write / run-code flag, path outside the
   roots, secret file and git dir keeps asking (or denying, as before). */

const GIT = ".git";
const base = realpathSync(mkdtempSync(join(tmpdir(), "readcmd-")));
const root = join(base, "root");
const outside = join(base, "outside");
for (const dir of [root, outside, join(root, GIT)]) mkdirSync(dir, { recursive: true });
writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
writeFileSync(join(root, "b.txt"), "beta\n");
writeFileSync(join(outside, "x.txt"), "x\n");
writeFileSync(join(root, ".env"), "SECRET=1");
symlinkSync(outside, join(root, "link"));

const ctx = { cwd: root, writePaths: [root], readPaths: [root] };
const d = (command: string) => checkToolCall(BASH_TOOL_NAME, { command }, ctx).decision;

test("allowed read commands inside the roots", () => {
  for (const c of [
    "ls",
    "ls -la",
    "ls -la a.txt",
    "cat a.txt",
    "head -n 2 a.txt",
    "tail -5 a.txt",
    "wc -l a.txt b.txt",
    "wc -l a.txt b.txt",
    "nl a.txt",
    "file a.txt",
    "stat a.txt",
    "du -sh .",
    "find . -name a.txt",
    "find . -type f -maxdepth 1",
    "grep -n alpha a.txt",

    "rg alpha a.txt",
    "sed -n 1,2p a.txt",
    "sed -n 1p a.txt",
    "sort a.txt",
    "cut -d, -f1 a.txt",
    "uniq a.txt",
    "git log --oneline | head -5",
    "cat a.txt | wc -l",
    `ls ${root}`,
  ])
    expect([c, d(c)]).toEqual([c, "allow"]);
});

test("flags that write or run code still ask", () => {
  for (const c of [
    "sed -i s/a/b/ a.txt",
    "sed -n s/a/b/p a.txt",
    "sed -n 1w out.txt a.txt",
    "sed s/a/b/ a.txt",
    "find . -exec rm {} ;",
    "find . -delete",
    "find . -execdir cat {} ;",
    "find . -fprint out.txt",
    "sort -o out.txt a.txt",
    "sort -ro out.txt a.txt",
    "grep --pre=cat x a.txt",
    "rg --pre cat x a.txt",
    "uniq a.txt out.txt",
    "tree -o out.txt",
  ])
    expect([c, d(c)]).toEqual([c, "ask"]);
});

test("paths outside the roots, escapes, expansions and secret files ask or deny", () => {
  expect(d(`cat ${join(outside, "x.txt")}`)).toBe("ask");
  expect(d("cat ../outside/x.txt")).toBe("ask");
  expect(d("cat link/x.txt")).toBe("ask"); // symlink out of the roots
  expect(d("ls link")).toBe("ask");
  expect(d("wc -l *")).toBe("ask"); // `*` also matches the symlink out of the roots
  expect(d("ls ~")).toBe("ask");
  expect(d("cat $HOME/x")).toBe("ask");
  expect(d("cat $(echo a.txt)")).toBe("ask");
  expect(d("cat `echo a.txt`")).toBe("ask");
  expect(d("cat {a,b}.txt")).toBe("ask");
  expect(d("ls /etc")).toBe("ask");
  expect(d("cat .env")).toBe("deny"); // secret file: the old reader rule
  expect(d("ls -d .e*")).toBe("ask"); // a glob that matches a secret file
});

test("git dir targets and redirects ask", () => {
  expect(d(`ls ${GIT}`)).toBe("ask");
  expect(d(`cat ${GIT}/config`)).toBe("ask");
  expect(d(`grep -r x ${join(root, GIT)}`)).toBe("ask");
  expect(d("cat a.txt > out.txt")).toBe("ask");
  expect(d("ls >> out.txt")).toBe("ask");
});

test("commands outside the set keep asking", () => {
  for (const c of [
    "awk 1 a.txt",
    "less a.txt",
    "cp a.txt c.txt",
    "mv a.txt c.txt",
    "tee a.txt",
    "base64 a.txt",
    "xxd a.txt",
    "od a.txt",
    "strings a.txt",
  ])
    expect([c, d(c)]).toEqual([c, "ask"]);
});

test("without a known cwd a relative path asks, an absolute one inside the roots passes", () => {
  const c = { writePaths: [root], readPaths: [root] };
  expect(checkToolCall(BASH_TOOL_NAME, { command: "cat a.txt" }, c).decision).toBe("ask");
  expect(checkToolCall(BASH_TOOL_NAME, { command: "ls" }, c).decision).toBe("ask");
  expect(checkToolCall(BASH_TOOL_NAME, { command: `cat ${join(root, "a.txt")}` }, c).decision).toBe(
    "allow",
  );
});
