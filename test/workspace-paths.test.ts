import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { ensureParentDir, workspacePaths } from "../src/workspace/workspace-paths";
import { makeEnv } from "./helpers";

test("paths derive from AGENT_HOME and task id", () => {
  const p = workspacePaths("/h");
  expect(p.dbFile).toBe("/h/data/agent.db");
  expect(p.appLog).toBe("/h/logs/app.jsonl");
  expect(p.taskLog("T1")).toBe("/h/logs/tasks/T1.jsonl");
  expect(p.task("T1").scratch).toBe("/h/tasks/T1/scratch");
  expect(p.task("T1").artifacts).toBe("/h/tasks/T1/artifacts");
  expect(p.repos).toBe("/h/repos");
  expect(p.worktrees).toBe("/h/worktrees");
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
