import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  ensureParentDir,
  isWorkspaceName,
  LOCATION_NAME,
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
  expect(p.backups).toBe("/h/backups");
  expect(p.workspaces).toBe("/h/workspaces");
});

test("workspace layout: workspaces/<ws>/{workspace.yaml,channels/<name>/MEMORY.md,cwd}; runs/<id>, artifacts/<ws>/<ch>", () => {
  const ws = workspacePaths("/h").workspace("shop");
  expect(ws.root).toBe("/h/workspaces/shop");
  expect(ws.config).toBe("/h/workspaces/shop/workspace.yaml");
  expect(ws.identity).toBe("/h/workspaces/shop/IDENTITY.md");
  expect(ws).not.toHaveProperty("memory");
  expect(ws.channel("ops").memory).toBe("/h/workspaces/shop/channels/ops/MEMORY.md");
  expect(ws.cwd).toBe("/h/workspaces/shop/cwd");
  expect(ws).not.toHaveProperty("tasks");
  // Run data and store artifacts live outside the workspace dir (config and memory only).
  expect(workspacePaths("/h").run("T1")).toBe("/h/runs/T1");
  expect(ws.artifacts).toBe("/h/artifacts/shop");
  expect(ws.channel("ops").artifacts).toBe("/h/artifacts/shop/ops");
  expect(ws.locations).toBe("/h/workspaces/shop/locations");
  expect(ws).not.toHaveProperty("location");
});

test("name rules: workspace lowercase-hyphen and not reserved; location allows dots and underscores", () => {
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
    expect(LOCATION_NAME.test(ok)).toBe(true);
  for (const bad of ["", ".hidden", "-a", "a b", "a/b", "..", "x".repeat(65)])
    expect(LOCATION_NAME.test(bad)).toBe(false);
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
