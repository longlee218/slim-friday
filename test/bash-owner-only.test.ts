import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall, type Decision } from "../src/guardrails/check-tool-call";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";

const root = realpathSync(mkdtempSync(join(tmpdir(), "friday-owner-only-")));
const ctx = { cwd: root, writePaths: [root], readPaths: [root] };
const bash = (command: string): Decision => checkToolCall(BASH_TOOL_NAME, { command }, ctx);

describe("gh / hub are hard denies (the app opens PRs)", () => {
  for (const c of ["gh pr create", "gh api -X POST /repos/x/y/issues", "hub pull-request"])
    test(c, () => expect(bash(c).decision).toBe("deny"));
});

describe("owner-only asks (never deferred to the classifier)", () => {
  const rows: [string, string][] = [
    ["env prefix PATH", "PATH=./bin make"],
    ["env prefix GIT_", "GIT_SSH_COMMAND=x git status"],
    ["env prefix NODE_OPTIONS", "NODE_OPTIONS=--inspect node x.js"],
    ["redirect outside write paths", "echo x > /etc/hosts"],
    ["redirect to home", "echo x > ~/.zshrc"],
    ["home expansion ~", "cat ~/notes.txt"],
    ["home expansion $HOME", "ls $HOME/.aws"],
    ["ssh", "ssh host ls"],
    ["rsync", "rsync -a a b"],
    ["curl upload flag", "curl -o out https://github.com/x"],
    ["curl non-allowlisted host", "curl https://example.com"],
    ["shell script", "bash run.sh"],
    ["xargs", "xargs gh"],
    ["find -exec", "find . -exec gh {} \\;"],
    ["command substitution", "$(echo gh)"],
    ["backtick substitution", "ls `echo x`"],
    ["unparseable", "echo 'unterminated"],
  ];
  for (const [name, c] of rows)
    test(name, () => {
      const d = bash(c);
      expect(d.decision).toBe("ask");
      expect(d.ownerOnly).toBe(true);
    });
  test("owner-only wins over a soft ask on another segment", () => {
    const d = bash("make && ssh host ls");
    expect(d).toMatchObject({ decision: "ask", ownerOnly: true });
  });
});

describe("soft asks (classifier may decide)", () => {
  for (const c of ["make", "mkdir x", "echo hi > out.txt", "bun run lint2"])
    test(c, () => {
      const d = bash(c);
      expect(d.decision).toBe("ask");
      expect(d.ownerOnly).toBeUndefined();
    });
});
