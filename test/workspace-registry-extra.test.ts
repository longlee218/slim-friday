import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { loadWorkspaces, warnOverlap } from "../src/workspaces/workspace-registry";
import { addLocation, makeEnv, outsideDir } from "./helpers";

/** Write a bare `workspace.yaml` (no locations) for a workspace dir name. */
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
  addLocation(env.home, "api", {}, { workspace: "7days" });
  const scan = loadWorkspaces(env.home);
  expect(scan.workspaces.map((w) => w.name)).toEqual(["7days"]);
});

test("workspace name at max length (32 chars) is valid", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const maxName = `a${"b".repeat(30)}c`; // 32 chars: first char + 31 of others
  addLocation(env.home, "api", {}, { workspace: maxName });
  const scan = loadWorkspaces(env.home);
  expect(scan.workspaces.map((w) => w.name)).toEqual([maxName]);
});

test("workspace name at 33 chars is invalid and skipped", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const tooLong = `a${"b".repeat(31)}c`; // 33 chars: too long
  rawWorkspace(env.home, tooLong);
  const scan = loadWorkspaces(env.home);
  expect(scan.workspaces).toEqual([]);
});

test("location names starting with digit are valid", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  addLocation(env.home, "7days-client", {}, { workspace: "main" });
  const scan = loadWorkspaces(env.home);
  expect(scan.workspaces[0]!.locations.map((r) => r.name)).toEqual(["7days-client"]);
});

test("duplicate channel is logged by the scan; overlapping locations only by warnOverlap (startup)", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const shared = fakeGit(join(outsideDir(), "shared"));
  addLocation(env.home, "a", {}, { workspace: "one", channels: [CH1], path: shared });
  addLocation(env.home, "b", {}, { workspace: "two", channels: [CH1], path: shared });
  const cap = captureLogs();
  const { workspaces } = loadWorkspaces(env.home);
  const scanEvents = cap.lines.map((l) => l.event);
  warnOverlap(workspaces);
  cap.stop();
  const events = cap.lines.map((l) => l.event);
  expect(scanEvents).toContain("channel.duplicate");
  expect(scanEvents).not.toContain("location.overlap"); // a re-scan per message stays quiet
  expect(events).toContain("location.overlap");
  expect(cap.lines.find((l) => l.event === "location.overlap")).toMatchObject({
    a: "one/a",
    b: "two/b",
  });
});

test("warnOverlap: a $HOME location nesting other locations is not warned; two equal repos still are", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const fakeHome = fakeGit(join(outsideDir(), "home"));
  const repo = fakeGit(join(fakeHome, "repo"));
  addLocation(env.home, "h", {}, { workspace: "one", channels: [CH1], path: fakeHome });
  addLocation(env.home, "r", {}, { workspace: "two", channels: [CH1], path: repo });
  addLocation(env.home, "r2", {}, { workspace: "three", channels: [CH1], path: repo });
  const { workspaces } = loadWorkspaces(env.home, join(outsideDir(), "other-home"));
  const cap = captureLogs();
  warnOverlap(workspaces, fakeHome);
  cap.stop();
  const pairs = cap.lines
    .filter((l) => l.event === "location.overlap")
    .map((l) => [l.a, l.b].sort());
  expect(pairs).toEqual([["three/r2", "two/r"]]);
});

test("location path equal to $HOME env is skipped even when userHome differs", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const envHome = fakeGit(join(env.home, "envhome"));
  addLocation(env.home, "h", {}, { workspace: "main", path: envHome });
  const saved = process.env.HOME;
  process.env.HOME = envHome;
  try {
    const scan = loadWorkspaces(env.home, join(env.home, "other-user-home"));
    expect(scan.workspaces[0]!.locations).toEqual([]);
  } finally {
    process.env.HOME = saved;
  }
});
