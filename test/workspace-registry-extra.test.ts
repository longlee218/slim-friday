import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addRepo, makeEnv } from "./helpers";

/** Write a bare `workspace.yaml` (no repos) for a workspace dir name. */
const rawWorkspace = (home: string, name: string, yaml = "channels: []\n"): void => {
  const root = join(home, "workspaces", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "workspace.yaml"), yaml);
};

const CH1 = "11111111111111111";

/** Fake git root dir. */
const fakeGit = (dir: string): string => {
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
};

test("workspace names starting with digit are valid", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  addRepo(env.home, "api", {}, { workspace: "7days" });
  const scan = loadWorkspaces(env.home);
  expect(scan.workspaces.map((w) => w.name)).toEqual(["7days"]);
});

test("workspace name at max length (32 chars) is valid", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const maxName = "a" + "b".repeat(30) + "c"; // 32 chars: first char + 31 of others
  addRepo(env.home, "api", {}, { workspace: maxName });
  const scan = loadWorkspaces(env.home);
  expect(scan.workspaces.map((w) => w.name)).toEqual([maxName]);
});

test("workspace name at 33 chars is invalid and skipped", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const tooLong = "a" + "b".repeat(31) + "c"; // 33 chars: too long
  rawWorkspace(env.home, tooLong);
  const scan = loadWorkspaces(env.home);
  expect(scan.workspaces).toEqual([]);
});

test("repo names starting with digit are valid", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  addRepo(env.home, "7days-client", {}, { workspace: "main" });
  const scan = loadWorkspaces(env.home);
  expect(scan.workspaces[0]!.repos.map((r) => r.name)).toEqual(["7days-client"]);
});

test("duplicate channel and overlapping repos are logged as warnings", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const shared = fakeGit(join(env.home, "shared"));
  addRepo(env.home, "a", {}, { workspace: "one", channels: [CH1], path: shared });
  addRepo(env.home, "b", {}, { workspace: "two", channels: [CH1], path: shared });
  const cap = captureLogs();
  loadWorkspaces(env.home);
  cap.stop();
  const events = cap.lines.map((l) => l.event);
  expect(events).toContain("channel.duplicate");
  expect(events).toContain("repo.overlap");
  expect(cap.lines.find((l) => l.event === "repo.overlap")).toMatchObject({
    a: "one/a",
    b: "two/b",
  });
});

test("repo path equal to $HOME env is skipped even when userHome differs", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const envHome = fakeGit(join(env.home, "envhome"));
  addRepo(env.home, "h", {}, { workspace: "main", path: envHome });
  const saved = process.env.HOME;
  process.env.HOME = envHome;
  try {
    const scan = loadWorkspaces(env.home, join(env.home, "other-user-home"));
    expect(scan.workspaces[0]!.repos).toEqual([]);
  } finally {
    process.env.HOME = saved;
  }
});
