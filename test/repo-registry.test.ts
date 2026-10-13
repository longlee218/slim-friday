import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { isManagedClone, refreshRepo } from "../src/repos/refresh-repo";
import { buildRegistryContext } from "../src/repos/repo-registry";
import { getSession } from "../src/storage/session-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { g, makeRepo } from "./git-fixture";
import { addRepo, clearWorkspaces, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

/** Create a fake git repo dir (a `.git` dir is all the validator checks). */
function fakeRepo(root: string, name: string): string {
  const p = join(root, name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
}

/** Repos of one workspace (default "main"), [] when it is missing or invalid. */
const reposOf = (home: string, ws = "main") =>
  loadWorkspaces(home).workspaces.find((w) => w.name === ws)?.repos ?? [];

test("loads one repo per repo.yaml; skips missing path, non-git dir, bad name and bad config", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const b = fakeRepo(env.home, "b");
  addRepo(env.home, "a", { description: "api", testCommand: "bun test" }); // default path = workspace/repo
  addRepo(env.home, "b", {}, { path: b });
  addRepo(env.home, "gone", {}, { path: join(env.home, "nope") });
  mkdirSync(join(env.home, "notgit"));
  addRepo(env.home, "plain", {}, { path: join(env.home, "notgit") });
  addRepo(env.home, "has space", {}, { path: b });
  const bad = workspacePaths(env.home).workspace("main").repo("bad");
  mkdirSync(bad.root, { recursive: true });
  writeFileSync(bad.config, "githubAccount: [not, a, string]\n");
  mkdirSync(join(env.home, "workspaces", "main", "repos", "no-config")); // a plain dir is not a repo
  const repos = reposOf(env.home);
  expect(repos.map((r) => r.name)).toEqual(["a", "b"]);
  expect(repos[0]).toMatchObject({ description: "api", testCommand: "bun test" });
  expect(repos[0]!.path).toBe(workspacePaths(env.home).workspace("main").repo("a").clone);
  expect(repos[0]!.workspace).toBe("main");
  expect(repos[0]!.dir).toBe(workspacePaths(env.home).workspace("main").repo("a").root);
});

test("returns empty when there is no workspaces dir or no valid workspace", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  expect(reposOf(env.home)).toEqual([]);
  mkdirSync(join(env.home, "workspaces"));
  expect(reposOf(env.home)).toEqual([]);
});

test("handler tells the owner to add a workspace when none exists", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const handle = createTurnHandler({ db: env.db, config: env.config });
  const reply = await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "t1",
    text: "hi",
  });
  expect(reply).toContain("not linked to a workspace");
});

test("registry block only for 2+ repos", () => {
  const one = [{ name: "a", workspace: "w", dir: "/w/a", path: "/a", description: "" }];
  expect(buildRegistryContext("w", one)).toBe("");
  expect(
    buildRegistryContext("w", [
      ...one,
      { name: "b", workspace: "w", dir: "/w/b", path: "/b", description: "web" },
    ]),
  ).toContain("- b: /b — web");
});

test("handler: unpinned uses all repos; pin sticks to thread; unknown pin rejected", async () => {
  const env = makeEnv();
  const a = fakeRepo(env.home, "a");
  const b = fakeRepo(env.home, "b");
  clearWorkspaces(env.home);
  addRepo(env.home, "a", {}, { path: a });
  addRepo(env.home, "b", {}, { path: b });
  const seen: any[] = [];
  const queryFn = (args: any) => {
    seen.push(args);
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTurnHandler({ db: env.db, config: env.config, queryFn: queryFn as never });
  const t = (threadId: string, text: string) => ({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId,
    text,
  });

  await handle(t("t1", "where is x?"));
  // Several repos, no pin: neutral cwd, every repo readable.
  expect(seen[0].options.cwd).toBe(workspacePaths(env.home).workspace("main").cwd);
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
  addRepo(env.home, "a", {}, { path: a });
  addRepo(env.home, "b", {}, { path: b });
  const seen: any[] = [];
  const queryFn = (args: any) => {
    seen.push(args);
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTurnHandler({ db: env.db, config: env.config, queryFn: queryFn as never });
  const t = (text: string) => ({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "t1",
    text,
  });
  await handle(t("repo:a first"));
  await handle(t("same repo follow up"));
  await handle(t("repo:b switch"));
  expect(seen[0].options.resume).toBeUndefined();
  expect(seen[1].options.resume).toBe("sess-1");
  expect(seen[2].options.resume).toBeUndefined();
});

test("isManagedClone: only workspaces/<ws>/repos/<repo>/repo; rejects other paths, .. and symlinks", () => {
  const env = makeEnv();
  const ws = workspacePaths(env.home);
  const repoDir = ws.workspace("x").repo("r").root;
  const inside = fakeRepo(repoDir, "repo");
  const outside = fakeRepo(env.home, "dev");
  symlinkSync(outside, join(repoDir, "link"));
  expect(isManagedClone(inside, env.home)).toBe(true);
  expect(isManagedClone(join(inside, ".."), env.home)).toBe(false); // the repo dir itself
  expect(isManagedClone(fakeRepo(ws.workspace("x").root, "repo"), env.home)).toBe(false); // old per-repo layout
  expect(isManagedClone(join(ws.workspaces, "x", "..", "..", "dev"), env.home)).toBe(false);
  expect(isManagedClone(join(repoDir, "link"), env.home)).toBe(false);
  expect(isManagedClone(fakeRepo(repoDir, "other"), env.home)).toBe(false);
  expect(isManagedClone("/nonexistent", env.home)).toBe(false);
});

test("refreshRepo: fetch + fast-forward with the git CLI, throttled per repo, failures swallowed", async () => {
  const up = await makeRepo("main", true); // repo with a bare origin
  const copy = join(up.root, "copy");
  await g(up.root, "clone", "-q", up.origin, copy);
  const push = async (name: string) => {
    writeFileSync(join(up.repo, name), "x\n");
    await g(up.repo, "add", "-A");
    await g(up.repo, "commit", "-qm", name);
    await g(up.repo, "push", "-q", "origin", "main");
  };
  const head = () => g(copy, "log", "-1", "--format=%s");
  await push("b.txt");
  await refreshRepo(copy, 1000);
  expect(await head()).toBe("b.txt"); // fast-forwarded
  await push("c.txt");
  await refreshRepo(copy, 1000 + 60_000); // inside the 10 min window: skipped
  expect(await head()).toBe("b.txt");
  await refreshRepo(copy, 1000 + 11 * 60_000);
  expect(await head()).toBe("c.txt");
  await expect(refreshRepo(join(up.root, "not-a-repo"))).resolves.toBeUndefined(); // failure swallowed
});

test("workflow: accepted and ignored (any value keeps the repo, no marker in the registry block)", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addRepo(env.home, "a");
  addRepo(env.home, "b", { workflow: "full" });
  addRepo(env.home, "c", { workflow: "heavy" });
  const repos = reposOf(env.home);
  expect(repos.map((r) => r.name)).toEqual(["a", "b", "c"]);
  expect(buildRegistryContext("main", repos, true)).not.toContain("workflow");
});
