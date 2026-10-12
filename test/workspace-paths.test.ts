import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  ensureParentDir,
  isWorkspaceName,
  REPO_NAME,
  workspacePaths,
} from "../src/config/workspace-paths";
import { assertTempHome, makeEnv } from "./helpers";

test("paths derive from AGENT_HOME and task id", () => {
  const p = workspacePaths("/h");
  expect(p.dbFile).toBe("/h/data/agent.db");
  expect(p.appLog()).toBe("/h/logs/app");
  expect(p.taskLog("T1")).toBe("/h/logs/tasks/T1.jsonl");
  expect(p.identity).toBe("/h/IDENTITY.md");
  expect(p.soul).toBe("/h/SOUL.md");
  expect(p.agents).toBe("/h/AGENTS.md");
  expect(p.user).toBe("/h/USER.md");
  expect(p.memory).toBe("/h/MEMORY.md");
  expect(p.bootstrap).toBe("/h/BOOTSTRAP.md");
  expect(p.memoryPending).toBe("/h/MEMORY.pending.md");
  expect(p.backups).toBe("/h/backups");
  expect(p.workspaces).toBe("/h/workspaces");
});

test("workspace layout: workspaces/<ws>/repos/<repo>/{repo.yaml,MEMORY.md,repo,worktrees}", () => {
  const ws = workspacePaths("/h").workspace("shop");
  expect(ws.root).toBe("/h/workspaces/shop");
  expect(ws.config).toBe("/h/workspaces/shop/workspace.yaml");
  expect(ws.identity).toBe("/h/workspaces/shop/IDENTITY.md");
  expect(ws.memory).toBe("/h/workspaces/shop/MEMORY.md");
  expect(ws.cwd).toBe("/h/workspaces/shop/cwd");
  expect(ws.tasks).toBe("/h/workspaces/shop/tasks");
  expect(ws.task("T1")).toEqual({
    root: "/h/workspaces/shop/tasks/T1",
    scratch: "/h/workspaces/shop/tasks/T1/scratch",
  });
  expect(ws.repos).toBe("/h/workspaces/shop/repos");
  expect(ws.repo("api")).toEqual({
    root: "/h/workspaces/shop/repos/api",
    config: "/h/workspaces/shop/repos/api/repo.yaml",
    memory: "/h/workspaces/shop/repos/api/MEMORY.md",
    clone: "/h/workspaces/shop/repos/api/repo",
  });
  expect(workspacePaths("/h").workspace("api").legacyConfig).toBe("/h/workspaces/api/config.yaml");
});

test("name rules: workspace lowercase-hyphen and not reserved; repo allows dots and underscores", () => {
  for (const ok of ["main", "a", "my-ws-2", "0x"]) expect(isWorkspaceName(ok)).toBe(true);
  for (const bad of [
    "",
    "-a",
    "Ops",
    "ops",
    "a.b",
    "a_b",
    "a b",
    ".hidden",
    "../x",
    "a".repeat(33),
  ])
    expect(isWorkspaceName(bad)).toBe(false);
  for (const ok of ["api", "Api_v2", "a.b-c", "x".repeat(64)])
    expect(REPO_NAME.test(ok)).toBe(true);
  for (const bad of ["", ".hidden", "-a", "a b", "a/b", "..", "x".repeat(65)])
    expect(REPO_NAME.test(bad)).toBe(false);
});

test("test helper refuses an AGENT_HOME outside the OS temp dir", () => {
  expect(() => assertTempHome(homedir())).toThrow("not under");
  expect(() => assertTempHome(makeEnv().home)).not.toThrow();
});

test("parent dirs are created owner-only (0700)", () => {
  const { paths } = makeEnv();
  const file = ensureParentDir(paths.taskLog("T2"));
  const dir = file.replace(/\/[^/]+$/, "");
  expect(existsSync(dir)).toBe(true);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("db and task log files are 0600", async () => {
  const { paths } = makeEnv(); // makeEnv opens the db
  expect(statSync(paths.dbFile).mode & 0o777).toBe(0o600);
  const { fileDestination } = await import("../src/observability/logger");
  const d = fileDestination(paths.taskLog("T3"));
  d.end();
  expect(statSync(paths.taskLog("T3")).mode & 0o777).toBe(0o600);
});
