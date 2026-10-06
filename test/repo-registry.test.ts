import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { isManagedClone, refreshRepo } from "../src/repos/refresh-repo";
import { buildRegistryContext, loadRepoRegistry } from "../src/repos/repo-registry";
import { getSession } from "../src/storage/session-store";
import { createTaskHandler } from "../src/tasks/handle-task";
import { addWorkspace, clearWorkspaces, makeEnv, resultMsg } from "./helpers";

/** Create a fake git repo dir (a `.git` dir is all the validator checks). */
function fakeRepo(root: string, name: string): string {
  const p = join(root, name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
}

test("loads one repo per workspace config.yaml; skips missing path, non-git dir, bad name and bad config", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const b = fakeRepo(env.home, "b");
  addWorkspace(env.home, "a", { description: "api", testCommand: "bun test" }); // default path = workspace/repo
  addWorkspace(env.home, "b", {}, b);
  addWorkspace(env.home, "gone", {}, join(env.home, "nope"));
  mkdirSync(join(env.home, "notgit"));
  addWorkspace(env.home, "plain", {}, join(env.home, "notgit"));
  addWorkspace(env.home, "has space", {}, b);
  const bad = workspacePaths(env.home).workspace("bad");
  mkdirSync(bad.root, { recursive: true });
  writeFileSync(bad.config, "githubAccount: [not, a, string]\n");
  mkdirSync(join(env.home, "workspaces", "no-config")); // a plain dir is not a workspace
  const repos = loadRepoRegistry(env.home);
  expect(repos.map((r) => r.name)).toEqual(["a", "b"]);
  expect(repos[0]).toMatchObject({ description: "api", testCommand: "bun test" });
  expect(repos[0]!.path).toBe(workspacePaths(env.home).workspace("a").repo);
  expect(repos[0]!.workspace).toBe(workspacePaths(env.home).workspace("a").root);
});

test("returns empty when there is no workspaces dir or no valid workspace", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  expect(loadRepoRegistry(env.home)).toEqual([]);
  mkdirSync(join(env.home, "workspaces"));
  expect(loadRepoRegistry(env.home)).toEqual([]);
});

test("handler tells the owner to add a workspace when none exists", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const handle = createTaskHandler({ db: env.db, config: env.config });
  const reply = await handle({ source: "t", userId: "u", threadId: "t1", text: "hi" });
  expect(reply).toContain("No workspace found");
});

test("registry block only for 2+ repos", () => {
  const one = [{ name: "a", workspace: "/w/a", path: "/a", description: "" }];
  expect(buildRegistryContext(one)).toBe("");
  expect(
    buildRegistryContext([
      ...one,
      { name: "b", workspace: "/w/b", path: "/b", description: "web" },
    ]),
  ).toContain("- b: /b — web");
});

test("handler: unpinned uses all repos; pin sticks to thread; unknown pin rejected", async () => {
  const env = makeEnv();
  const a = fakeRepo(env.home, "a");
  const b = fakeRepo(env.home, "b");
  clearWorkspaces(env.home);
  addWorkspace(env.home, "a", {}, a);
  addWorkspace(env.home, "b", {}, b);
  const seen: any[] = [];
  const queryFn = (args: any) => {
    seen.push(args);
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never });
  const t = (threadId: string, text: string) => ({ source: "t", userId: "u", threadId, text });

  await handle(t("t1", "where is x?"));
  // Several repos, no pin: neutral cwd, every repo readable.
  expect(seen[0].options.cwd).toBe(join(env.home, "cwd"));
  expect(seen[0].options.additionalDirectories).toEqual([a, b]);
  expect(seen[0].options.systemPrompt.append).toContain("Available repos");

  await handle(t("t2", "repo:b where is y?"));
  expect(seen[1].prompt).toBe("where is y?");
  expect(seen[1].options.cwd).toBe(b);
  expect(seen[1].options.additionalDirectories).toBeUndefined();
  expect(getSession(env.db, "t2")?.repo).toBe("b");

  await handle(t("t2", "follow up")); // no prefix: stays on b
  expect(seen[2].options.cwd).toBe(b);

  expect(await handle(t("t3", "repo:zzz hi"))).toContain("Unknown repo");
  expect(await handle(t("t3", "repo:a"))).toContain("Send your question");
  expect(seen).toHaveLength(3);
});

test("re-pinning to another repo starts a fresh session (no resume across cwd)", async () => {
  const env = makeEnv();
  const a = fakeRepo(env.home, "a");
  const b = fakeRepo(env.home, "b");
  clearWorkspaces(env.home);
  addWorkspace(env.home, "a", {}, a);
  addWorkspace(env.home, "b", {}, b);
  const seen: any[] = [];
  const queryFn = (args: any) => {
    seen.push(args);
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never });
  const t = (text: string) => ({ source: "t", userId: "u", threadId: "t1", text });
  await handle(t("repo:a first"));
  await handle(t("same repo follow up"));
  await handle(t("repo:b switch"));
  expect(seen[0].options.resume).toBeUndefined();
  expect(seen[1].options.resume).toBe("sess-1");
  expect(seen[2].options.resume).toBeUndefined();
});

test("isManagedClone: only workspaces/<name>/repo; rejects other paths, .. and symlinks", () => {
  const env = makeEnv();
  const ws = workspacePaths(env.home);
  const inside = fakeRepo(ws.workspace("x").root, "repo");
  const outside = fakeRepo(env.home, "dev");
  symlinkSync(outside, join(ws.workspace("x").root, "link"));
  expect(isManagedClone(inside, env.home)).toBe(true);
  expect(isManagedClone(join(inside, ".."), env.home)).toBe(false); // the workspace dir itself
  expect(isManagedClone(join(ws.workspaces, "x", "..", "..", "dev"), env.home)).toBe(false);
  expect(isManagedClone(join(ws.workspace("x").root, "link"), env.home)).toBe(false);
  expect(isManagedClone(fakeRepo(ws.workspace("x").root, "other"), env.home)).toBe(false);
  expect(isManagedClone("/nonexistent", env.home)).toBe(false);
});

test("refreshRepo: fetch + fast-forward through the MCP tools, throttled per repo, failures swallowed", async () => {
  const calls: string[] = [];
  const fake = { call: async (tool: string) => (calls.push(tool), {}), close: async () => {} };
  await refreshRepo(fake, "/p", 1000);
  await refreshRepo(fake, "/p", 1000 + 60_000); // inside the 10 min window
  await refreshRepo(fake, "/p", 1000 + 11 * 60_000);
  expect(calls).toEqual(["git_fetch", "git_pull", "git_fetch", "git_pull"]);
  const failing = {
    call: async () => {
      throw new Error("no remote");
    },
    close: async () => {},
  };
  await expect(refreshRepo(failing, "/q")).resolves.toBeUndefined();
});
