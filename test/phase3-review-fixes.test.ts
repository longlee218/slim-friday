import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { openDb } from "../src/storage/db";
import { cancelRunningTasks, insertTask, setTaskStatus } from "../src/storage/run-store";
import { makeEnv } from "./helpers";

function ctx() {
  const env = makeEnv();
  const scratch = join(env.home, "scratch");
  mkdirSync(scratch);
  const outside = join(env.home, "outside");
  mkdirSync(outside);
  const root = realpathSync(scratch);
  return {
    scratch: root,
    outside: realpathSync(outside),
    c: { allowedPaths: [root], allowedReadPaths: [root, realpathSync(env.repo)] },
    env,
  };
}

test("reads: inside allowed dirs ok; outside, home dotfiles, symlink escape and absolute globs denied", () => {
  const { scratch, outside, c, env } = ctx();
  symlinkSync(outside, join(scratch, "link"));
  const d = (tool: string, input: Record<string, unknown>) =>
    checkToolCall(tool, input, c).decision;
  expect(d("Read", { file_path: join(scratch, "a.txt") })).toBe("allow");
  expect(d("Read", { file_path: join(env.repo, "src", "x.ts") })).toBe("allow");
  expect(d("Read", { file_path: join(outside, "a.txt") })).toBe("deny");
  expect(d("Read", { file_path: join(scratch, "link", "a.txt") })).toBe("deny");
  expect(d("Read", { file_path: "/etc/hosts" })).toBe("deny");
  expect(d("Grep", { pattern: "x", path: outside })).toBe("deny");
  expect(d("Grep", { pattern: "x" })).toBe("allow"); // defaults to cwd
  expect(d("Glob", { pattern: "/Users/**/*.json" })).toBe("deny");
  expect(d("Glob", { pattern: "../**" })).toBe("deny");
  expect(d("Glob", { pattern: "src/**/*.ts" })).toBe("allow");
  expect(d("Read", { file_path: join(scratch, "../x") })).toBe("deny");
});

test("secret names: dotfile credentials denied even inside allowed dirs", () => {
  const { scratch, c } = ctx();
  for (const f of [".credentials.json", ".npmrc", ".netrc", ".pgpass", "cert.p12"]) {
    expect(checkToolCall("Read", { file_path: join(scratch, f) }, c).decision).toBe("deny");
  }
});

test("bash bypasses from review: file-output flags, git --no-index, git secret pathspec, env overrides", () => {
  const { c } = ctx();
  const d = (cmd: string) => checkToolCall("Bash", { command: cmd }, c).decision;
  expect(d("curl -o ~/.zshrc https://github.com/x")).toBe("ask");
  expect(d("wget -O out https://github.com/x")).toBe("ask");
  expect(d("curl -sSLo f https://api.github.com/x")).toBe("ask");
  expect(d("curl https://api.github.com/x")).toBe("allow");
  expect(d("git diff --no-index /a /b")).toBe("deny");
  expect(d("git diff HEAD -- .env")).toBe("deny");
  expect(d("PATH=/tmp git status")).toBe("ask");
  expect(d("GIT_EXTERNAL_DIFF=./x git diff")).toBe("ask");
  expect(d("git status")).toBe("allow");
});

test("restart cleanup: waiting_approval tasks and pending approvals are cancelled", () => {
  const db = openDb(":memory:");
  insertTask(db, { id: "t1", threadId: "th", source: "d", repo: "r", type: "code" });
  setTaskStatus(db, "t1", "waiting_approval");
  db.run(
    "INSERT INTO approvals (id, task_id, tool, summary, decision, requested_at) VALUES ('a','t1','Bash','s','pending',1)",
  );
  cancelRunningTasks(db);
  expect((db.query("SELECT status FROM tasks").get() as any).status).toBe("cancelled");
  expect((db.query("SELECT decision FROM approvals").get() as any).decision).toBe("cancelled");
});
