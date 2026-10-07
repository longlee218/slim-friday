import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";

const ctx = { writePaths: ["/tmp/wt"] };

/** Git in the shell: reads are fine, everything else belongs to the git MCP tools (or to the app). */
const rows: [string, "allow" | "ask" | "deny"][] = [
  ["git status", "allow"],
  ["git diff HEAD~1", "allow"],
  ["git log --oneline -5", "allow"],
  ["git diff --output=/tmp/x", "ask"],
  ["git diff --no-index /a /b", "deny"],
  ["git diff HEAD -- .env", "deny"],
  // mutating commands: use the git MCP tools
  ["git add .", "deny"],
  ['git commit -m "feat: x"', "deny"],
  ["git add . && git commit -m x", "deny"],
  ["git checkout main", "deny"],
  ["git reset --hard", "deny"],
  ["git clean -fd", "deny"],
  ["git config user.name x", "deny"],
  ["git rebase main", "deny"],
  ["git worktree add ../x", "deny"],
  ["git -C /other commit -m x", "deny"],
  // pushing is the app's job
  ["git push origin feat", "deny"],
  ["git push origin main", "deny"],
  ["git push --force origin feat", "deny"],
];

describe("git in the shell", () => {
  for (const [cmd, want] of rows) {
    test(`${cmd} -> ${want}`, () => {
      expect(checkToolCall(BASH_TOOL_NAME, { command: cmd }, ctx).decision).toBe(want);
    });
  }
});

test("cd inside the allowed dirs is allowed; outside, parent and home are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-"));
  const root = realpathSync(dir);
  const c = { writePaths: [root] };
  const d = (cmd: string) => checkToolCall(BASH_TOOL_NAME, { command: cmd }, c).decision;
  expect(d(`cd ${root}`)).toBe("allow");
  expect(d(`cd ${root} && git status`)).toBe("allow");
  expect(d("cd sub")).toBe("allow");
  expect(d("cd ..")).toBe("ask");
  expect(d("cd ~")).toBe("ask");
  expect(d("cd /etc")).toBe("ask");
  expect(d(`cd ${root} && git push`)).toBe("deny");
});

describe("git MCP tools (@cyanheads/git-mcp-server)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gm-")));
  const other = realpathSync(mkdtempSync(join(tmpdir(), "gm2-")));
  const readable = realpathSync(mkdtempSync(join(tmpdir(), "gm3-")));
  const c = { writePaths: [dir], gitWriteRepo: dir, gitReadRepos: [readable] };
  const d = (tool: string, input: Record<string, unknown> = {}, path = dir) =>
    checkToolCall(mcpToolName(GIT_MCP_SERVER, tool), { path, ...input }, c).decision;

  test("reads work on the worktree and registered repos; any other path is denied", () => {
    for (const t of [GIT_TOOL.STATUS, GIT_TOOL.DIFF, GIT_TOOL.LOG, GIT_TOOL.SHOW, GIT_TOOL.BLAME]) {
      expect(d(t)).toBe("allow");
      expect(d(t, {}, readable)).toBe("allow");
      expect(d(t, {}, other)).toBe("deny");
    }
    expect(d(GIT_TOOL.STATUS, {}, "/nonexistent")).toBe("deny");
    expect(checkToolCall(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.STATUS), {}, c).decision).toBe(
      "deny",
    ); // path is mandatory
  });

  test("mode-based tools: list-like modes are reads, changing modes are denied", () => {
    expect(d(GIT_TOOL.BRANCH, { mode: "list" })).toBe("allow");
    expect(d(GIT_TOOL.BRANCH, { mode: "show-current" })).toBe("allow");
    expect(d(GIT_TOOL.BRANCH, { mode: "create", branchName: "x" })).toBe("deny");
    expect(d(GIT_TOOL.BRANCH, { mode: "delete", branchName: "x" })).toBe("deny");
    // git_remote/tag/stash/worktree are hidden in every mode (the app uses them): denied for agents.
    expect(d(GIT_TOOL.REMOTE, { mode: "get-url", name: "origin" })).toBe("deny");
    expect(d(GIT_TOOL.TAG, { mode: "list" })).toBe("deny");
    expect(d(GIT_TOOL.STASH, { mode: "pop" })).toBe("deny");
  });

  test("writes only in the worktree: add/commit allowed, never on a read-only repo", () => {
    expect(d(GIT_TOOL.ADD, { paths: ["a"] })).toBe("allow");
    expect(d(GIT_TOOL.COMMIT, { message: "feat: x" })).toBe("allow");
    expect(d(GIT_TOOL.ADD, { paths: ["a"] }, readable)).toBe("deny");
    expect(d(GIT_TOOL.COMMIT, { message: "x" }, readable)).toBe("deny");
  });

  test("commit cannot pick an author, amend, skip hooks or carry attribution", () => {
    expect(d(GIT_TOOL.COMMIT, { message: "x", author: { name: "A", email: "a@a.a" } })).toBe(
      "deny",
    );
    expect(d(GIT_TOOL.COMMIT, { message: "x", amend: true })).toBe("deny");
    expect(d(GIT_TOOL.COMMIT, { message: "x", noVerify: true })).toBe("deny");
    expect(
      d(GIT_TOOL.COMMIT, { message: "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>" }),
    ).toBe("deny");
  });

  test("branch/history changes ask; push, pull, fetch, clean, merge, worktree... are the app's job: denied", () => {
    expect(d(GIT_TOOL.CHECKOUT, { target: "main" })).toBe("ask");
    expect(d(GIT_TOOL.RESET, { mode: "soft" })).toBe("ask");
    expect(d(GIT_TOOL.RESET, { mode: "hard" })).toBe("deny");
    for (const t of [
      GIT_TOOL.PUSH,
      GIT_TOOL.PULL,
      GIT_TOOL.FETCH,
      GIT_TOOL.CLONE,
      GIT_TOOL.INIT,
      GIT_TOOL.CLEAN,
      GIT_TOOL.MERGE,
      GIT_TOOL.REBASE,
      GIT_TOOL.CHERRY_PICK,
      GIT_TOOL.WORKTREE,
      GIT_TOOL.SET_WORKING_DIR,
      GIT_TOOL.WRAPUP_INSTRUCTIONS,
    ]) {
      expect(d(t, t === GIT_TOOL.WORKTREE ? { mode: "add" } : {})).toBe("deny");
    }
    expect(d(GIT_TOOL.WORKTREE, { mode: "list" })).toBe("deny");
    expect(checkToolCall(mcpToolName("evil", "x"), {}, c).decision).toBe("deny");
  });
});

test("git_commit messages with attribution lines are denied; plain ones pass", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ga-")));
  const c = { writePaths: [dir], gitWriteRepo: dir };
  const d = (message: string) =>
    checkToolCall(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.COMMIT), { path: dir, message }, c).decision;
  expect(d("feat: add b")).toBe("allow");
  expect(d("fix: handle co-author lists")).toBe("allow");
  expect(d("feat: add b\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>")).toBe("deny");
  expect(d("fix\n\n🤖 Generated with Claude Code")).toBe("deny");
  expect(d("fix\n\nGenerated by an assistant")).toBe("deny");
});
