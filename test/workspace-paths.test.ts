import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { ensureParentDir, workspacePaths } from "../src/config/workspace-paths";
import { makeEnv } from "./helpers";

test("paths derive from AGENT_HOME and task id", () => {
  const p = workspacePaths("/h");
  expect(p.dbFile).toBe("/h/data/agent.db");
  expect(p.appLog()).toBe("/h/logs/app");
  expect(p.appLog("api")).toBe("/h/workspaces/api/logs/app");
  expect(p.taskLog("T1")).toBe("/h/logs/tasks/T1.jsonl");
  expect(p.task("T1").scratch).toBe("/h/tasks/T1/scratch");
  expect(p.task("T1").artifacts).toBe("/h/tasks/T1/artifacts");
  expect(p.taskLog("T1", "api")).toBe("/h/workspaces/api/logs/tasks/T1.jsonl");
  expect(p.identity).toBe("/h/IDENTITY.md");
  expect(p.soul).toBe("/h/SOUL.md");
  const ws = p.workspace("api");
  expect(ws.config).toBe("/h/workspaces/api/config.yaml");
  expect(ws.memory).toBe("/h/workspaces/api/MEMORY.md");
  expect(ws.repo).toBe("/h/workspaces/api/repo");
  expect(ws.worktrees).toBe("/h/workspaces/api/worktrees");
  expect(ws.tasks).toBe("/h/workspaces/api/tasks");
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
