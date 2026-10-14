import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { buildLocationsContext, loadLocations } from "../src/locations/location-registry";
import { makeEnv } from "./helpers";

test("loadLocations: a plain directory and a git directory; `git` is computed", () => {
  const env = makeEnv();
  const out = mkdtempSync(join(tmpdir(), "friday-out-"));
  const plain = join(out, "notes");
  const code = join(out, "code");
  mkdirSync(plain, { recursive: true });
  mkdirSync(join(code, ".git"), { recursive: true });
  const got = loadLocations(
    [
      { name: "notes", path: plain, description: "my notes" },
      { name: "code", path: code },
    ],
    workspacePaths(env.home).workspace("w"),
  );
  expect(got).toEqual([
    { name: "notes", workspace: "w", path: plain, description: "my notes", git: false },
    { name: "code", workspace: "w", path: code, description: "", git: true },
  ]);
});

test("loadLocations: missing path, a file, duplicate name, bad name and extra keys are skipped", () => {
  const env = makeEnv();
  const out = mkdtempSync(join(tmpdir(), "friday-out-"));
  const dir = join(out, "d");
  const file = join(out, "f.txt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "x");
  const got = loadLocations(
    [
      { name: "ok", path: dir },
      { name: "ok", path: dir },
      { name: "missing", path: join(env.home, "nope") },
      { name: "file", path: file },
      { name: "bad name", path: dir },
      { name: "extra", path: dir, testCommand: "bun test" },
      "not an object",
    ],
    workspacePaths(env.home).workspace("w"),
  );
  expect(got.map((l) => l.name)).toEqual(["ok"]);
});

test("loadLocations: a path that covers a forbidden dir (the home) is skipped", () => {
  const env = makeEnv();
  const out = mkdtempSync(join(tmpdir(), "friday-out-"));
  const home = join(out, "fake-home");
  mkdirSync(join(home, "proj"), { recursive: true });
  const link = join(out, "link");
  symlinkSync(home, link);
  const entries = [
    { name: "top", path: out },
    { name: "viaLink", path: link },
    { name: "inside", path: join(home, "proj") },
  ];
  const got = loadLocations(entries, workspacePaths(env.home).workspace("w"), [home]);
  expect(got.map((l) => l.name)).toEqual(["inside"]);
});

test("buildLocationsContext: one line per location, [git] marker, nothing for one unless forced", () => {
  const locs = [
    { name: "a", workspace: "w", path: "/a", description: "alpha", git: true },
    { name: "b", workspace: "w", path: "/b", description: "", git: false },
  ];
  const text = buildLocationsContext("w", locs);
  expect(text).toContain("- a: /a [git] — alpha");
  expect(text).toContain("- b: /b");
  expect(text).not.toContain("/b [git]");
  expect(buildLocationsContext("w", locs.slice(0, 1))).toBe("");
  expect(buildLocationsContext("w", locs.slice(0, 1), true)).toContain("- a: /a");
});

test("loadLocations: a path inside AGENT_HOME is skipped, except the workspace's own locations/ subtree", () => {
  const env = makeEnv();
  const ws = workspacePaths(env.home).workspace("w");
  mkdirSync(join(env.home, "data"), { recursive: true });
  mkdirSync(join(ws.root, "cwd"), { recursive: true });
  mkdirSync(join(ws.root, "locations", "app", "repo"), { recursive: true });
  mkdirSync(join(env.home, "workspaces", "other", "locations", "x"), { recursive: true });
  const got = loadLocations(
    [
      { name: "data", path: join(env.home, "data") },
      { name: "cwd", path: join(ws.root, "cwd") },
      { name: "other", path: join(env.home, "workspaces", "other", "locations", "x") },
      { name: "own", path: join(ws.root, "locations", "app", "repo") },
    ],
    ws,
    [env.home],
  );
  expect(got.map((l) => l.name)).toEqual(["own"]);
});
