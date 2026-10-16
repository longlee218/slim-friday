import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/policy/check-tool-call";
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
