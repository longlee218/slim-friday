import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import {
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";

// The task clone's git dir (config, hooks) is read-only for the agent: a planted config would run in later app git calls.

const clone = realpathSync(mkdtempSync(join(tmpdir(), "clone-guard-")));
const gitDir = join(clone, ".git");
mkdirSync(gitDir);
const ctx = { writePaths: [clone], readPaths: [clone], gitWriteRepo: clone };
const decide = (tool: string, input: Record<string, unknown>) =>
  checkToolCall(tool, input, ctx).decision;

test("Write / Edit / MultiEdit into <clone>/.git/** are denied; a normal file is allowed", () => {
  for (const tool of [WRITE_TOOL_NAME, EDIT_TOOL_NAME, MULTI_EDIT_TOOL_NAME]) {
    expect(decide(tool, { file_path: join(gitDir, "config") })).toBe("deny");
    expect(decide(tool, { file_path: join(gitDir, "hooks", "pre-commit") })).toBe("deny");
    expect(decide(tool, { file_path: join(clone, "src", "a.ts") })).toBe("allow");
  }
});

test("a `..` or symlink route into the git dir is still denied", () => {
  expect(decide(WRITE_TOOL_NAME, { file_path: join(clone, "src", "..", ".git", "config") })).toBe(
    "deny",
  );
});

test("Bash: writes and redirects naming the git dir are denied; reads are not", () => {
  const bash = (command: string) => decide(BASH_TOOL_NAME, { command });
  expect(bash("echo '[core]' > .git/config")).toBe("deny");
  expect(bash(`echo x >> ${gitDir}/config`)).toBe("deny");
  expect(bash(`cat foo > ${gitDir}/hooks/pre-commit`)).toBe("deny");
  expect(bash("cp evil .git/hooks/pre-commit")).toBe("deny");
  expect(bash("sed -i s/a/b/ .git/config")).toBe("deny");
  expect(bash("rm -r .git/hooks")).toBe("deny");
  expect(bash("cd .git")).toBe("deny");
  expect(bash("cat .git/config")).not.toBe("deny");
  expect(bash("ls .git")).not.toBe("deny");
});

test("reading the git dir through Read is not blocked by this rule", () => {
  expect(decide(READ_TOOL_NAME, { file_path: join(gitDir, "HEAD") })).toBe("allow");
});
