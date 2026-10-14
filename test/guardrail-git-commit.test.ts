import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";

const ctx = { cwd: "/tmp/wt", writePaths: ["/tmp/wt"] };

/** Git in the shell: only force push, push to main/master, a worktree outside the dir and secret pathspecs are denied; the rest is the agent's. */
const rows: [string, "allow" | "deny"][] = [
  ["git status", "allow"],
  ["git diff HEAD~1", "allow"],
  ["git log --oneline -5", "allow"],
  ["git diff --output=/tmp/x", "allow"],
  ["git diff --no-index /a /b", "allow"],
  ["git diff HEAD -- .env", "deny"],
  // mutating commands are no longer denied (the agent owns git)
  ["git add .", "allow"],
  ['git commit -m "feat: x"', "allow"],
  ["git add . && git commit -m x", "allow"],
  ["git checkout main", "allow"],
  ["git reset --hard", "allow"],
  ["git config user.name x", "allow"],
  ["git rebase main", "allow"],
  ["git -C /other commit -m x", "allow"],
  // worktrees: placed by the worktree rule (bash-policy.test.ts), not here
  ["git worktree add ../x", "deny"],
  // the agent pushes (Rev 15 phase 3), except force and main/master
  ["git push origin feat", "allow"],
  ["git push -u origin friday/x", "allow"],
  ["git push origin main", "deny"],
  ["git push origin HEAD:master", "deny"],
  ["git push --force origin feat", "deny"],
  ["git push -f", "deny"],
];

describe("git in the shell", () => {
  for (const [cmd, want] of rows) {
    test(`${cmd} -> ${want}`, () => {
      expect(checkToolCall(BASH_TOOL_NAME, { command: cmd }, ctx).decision).toBe(want);
    });
  }
});

test("cd is not tracked or judged any more: it is allowed anywhere; the segments after it are judged as ever", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-"));
  const root = realpathSync(dir);
  const c = { cwd: root, writePaths: [root] };
  const d = (cmd: string) => checkToolCall(BASH_TOOL_NAME, { command: cmd }, c).decision;
  expect(d(`cd ${root}`)).toBe("allow");
  expect(d(`cd ${root} && git status`)).toBe("allow");
  expect(d("cd sub")).toBe("allow");
  expect(d("cd ..")).toBe("allow");
  expect(d("cd ~")).toBe("allow");
  expect(d("cd /etc")).toBe("allow");
  expect(d(`cd ${root} && git push origin main`)).toBe("deny");
  expect(d(`cd ${root} && git push origin feat`)).toBe("allow");
});

describe("git MCP tools (@cyanheads/git-mcp-server): the assistant's read scope only", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gm-")));
  const other = realpathSync(mkdtempSync(join(tmpdir(), "gm2-")));
  const c = { writePaths: [], gitReadPaths: [dir] };
  const d = (tool: string, input: Record<string, unknown> = {}, path = dir) =>
    checkToolCall(mcpToolName(GIT_MCP_SERVER, tool), { path, ...input }, c).decision;

  test("reads work on registered locations; any other path is denied", () => {
    for (const t of [GIT_TOOL.STATUS, GIT_TOOL.DIFF, GIT_TOOL.LOG, GIT_TOOL.SHOW, GIT_TOOL.BLAME]) {
      expect(d(t)).toBe("allow");
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
    expect(d(GIT_TOOL.REMOTE, { mode: "get-url", name: "origin" })).toBe("deny");
    expect(d(GIT_TOOL.TAG, { mode: "list" })).toBe("deny");
    expect(d(GIT_TOOL.STASH, { mode: "pop" })).toBe("deny");
  });

  test("every non-read tool is denied, even on a registered location (the dev agent uses the shell)", () => {
    for (const t of [
      GIT_TOOL.ADD,
      GIT_TOOL.COMMIT,
      GIT_TOOL.CHECKOUT,
      GIT_TOOL.RESET,
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
    expect(checkToolCall(mcpToolName("evil", "x"), {}, c).decision).toBe("deny");
  });
});
