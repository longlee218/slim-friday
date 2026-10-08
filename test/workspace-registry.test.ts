import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addRepo, makeEnv } from "./helpers";

const CH1 = "11111111111111111";
const CH2 = "22222222222222222";

/** Scenario: builds fixtures under a temp home, then names what the scan must return. */
interface Case {
  name: string;
  /** Returns the fake $HOME to scan with (default: the real one). */
  setup: (env: ReturnType<typeof makeEnv>) => string | undefined | void;
  /** Loaded workspaces as `ws:repo,repo|ws2`. */
  loaded: string[];
  legacy?: string[];
  /** Channels per workspace after the scan. */
  channels?: Record<string, string[]>;
}

/** Fake git root dir. */
const fakeGit = (dir: string): string => {
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
};

/** Write a bare `workspace.yaml` (no repos) for a workspace dir name, whatever the name. */
const rawWorkspace = (home: string, name: string, yaml = "channels: []\n"): void => {
  const root = join(home, "workspaces", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "workspace.yaml"), yaml);
};

const cases: Case[] = [
  {
    name: "valid workspaces with repos, sorted",
    setup: ({ home }) => {
      addRepo(home, "api", {}, { workspace: "shop" });
      addRepo(home, "web", {}, { workspace: "shop" });
      addRepo(home, "cli", {}, { workspace: "alpha", channels: [CH1] });
    },
    loaded: ["alpha:cli", "shop:api,web"],
    channels: { alpha: [CH1], shop: [] },
  },
  {
    name: "legacy dir (config.yaml, no workspace.yaml) is listed and never loaded",
    setup: ({ home }) => {
      addRepo(home, "api", {}, { workspace: "main" });
      const old = join(home, "workspaces", "oldrepo");
      mkdirSync(join(old, "repo", ".git"), { recursive: true });
      writeFileSync(join(old, "config.yaml"), `path: ${join(old, "repo")}\n`);
    },
    loaded: ["main:api"],
    legacy: ["oldrepo"],
  },
  {
    name: "symlinked workspace dir is skipped",
    setup: ({ home }) => {
      addRepo(home, "api", {}, { workspace: "real" });
      symlinkSync(join(home, "workspaces", "real"), join(home, "workspaces", "link"));
    },
    loaded: ["real:api"],
  },
  {
    name: "symlinked repo dir is skipped",
    setup: ({ home }) => {
      addRepo(home, "api", {}, { workspace: "main" });
      symlinkSync(
        workspacePaths(home).workspace("main").repo("api").root,
        join(home, "workspaces", "main", "repos", "alias"),
      );
    },
    loaded: ["main:api"],
  },
  {
    name: "bad workspace names are skipped (.hidden, 'a b', Ops, ops, a.b)",
    setup: ({ home }) => {
      for (const n of [".hidden", "a b", "Ops", "ops", "a.b", "ok-name"]) rawWorkspace(home, n);
    },
    loaded: ["ok-name:"],
  },
  {
    name: "invalid workspace.yaml (bad channel id, wrong type) is skipped",
    setup: ({ home }) => {
      rawWorkspace(home, "bad-id", "channels: [abc]\n");
      rawWorkspace(home, "bad-type", "channels: 5\n");
      rawWorkspace(home, "good");
    },
    loaded: ["good:"],
  },
  {
    name: "a channel listed by 2 workspaces is dropped from both",
    setup: ({ home }) => {
      addRepo(home, "a", {}, { workspace: "one", channels: [CH1, CH2] });
      addRepo(home, "b", {}, { workspace: "two", channels: [CH1] });
    },
    loaded: ["one:a", "two:b"],
    channels: { one: [CH2], two: [] },
  },
  {
    name: "bad repo names and repos that are not git roots are skipped",
    setup: ({ home }) => {
      addRepo(home, "good", {}, { workspace: "main" });
      addRepo(home, ".hidden", {}, { workspace: "main" });
      addRepo(home, "has space", {}, { workspace: "main" });
      mkdirSync(join(home, "notgit"));
      addRepo(home, "plain", {}, { workspace: "main", path: join(home, "notgit") });
    },
    loaded: ["main:good"],
  },
  {
    name: "repo path equal to AGENT_HOME is skipped",
    setup: ({ home }) => {
      mkdirSync(join(home, ".git"));
      addRepo(home, "all", {}, { workspace: "main", path: home });
      addRepo(home, "fine", {}, { workspace: "main" });
    },
    loaded: ["main:fine"],
  },
  {
    name: "repo path above $HOME (an ancestor) is skipped",
    setup: ({ home }) => {
      const top = fakeGit(join(home, "top"));
      const me = join(top, "sub", "me");
      mkdirSync(me, { recursive: true });
      addRepo(home, "anc", {}, { workspace: "main", path: top });
      return me;
    },
    loaded: ["main:"],
  },
  {
    name: "repo path equal to $HOME is skipped",
    setup: ({ home }) => {
      const fakeHome = fakeGit(join(home, "fakehome"));
      addRepo(home, "tilde", {}, { workspace: "main", path: fakeHome });
      return fakeHome;
    },
    loaded: ["main:"],
  },
  {
    name: "overlapping repo paths across workspaces are both kept (warning only)",
    setup: ({ home }) => {
      const shared = fakeGit(join(home, "shared"));
      addRepo(home, "a", {}, { workspace: "one", path: shared });
      addRepo(home, "b", {}, { workspace: "two", path: shared });
    },
    loaded: ["one:a", "two:b"],
  },
];

test.each(cases)("loadWorkspaces: $name", (c) => {
  const env = makeEnv();
  // Start from an empty registry (makeEnv seeds one repo for other suites).
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const scan = loadWorkspaces(env.home, c.setup(env) ?? undefined);
  expect(scan.workspaces.map((w) => `${w.name}:${w.repos.map((r) => r.name).join(",")}`)).toEqual(
    c.loaded,
  );
  expect(scan.legacy).toEqual(c.legacy ?? []);
  for (const [ws, channels] of Object.entries(c.channels ?? {}))
    expect(scan.workspaces.find((w) => w.name === ws)?.channels).toEqual(channels);
});

test("loadWorkspaces: missing workspaces dir gives an empty scan", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  expect(loadWorkspaces(env.home)).toEqual({ workspaces: [], legacy: [] });
});

test("loaded repos carry workspace name, repo dir and absolute path", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  addRepo(env.home, "api", { description: "billing" }, { workspace: "shop" });
  const repo = loadWorkspaces(env.home).workspaces[0]!.repos[0]!;
  const p = workspacePaths(env.home).workspace("shop").repo("api");
  expect(repo).toMatchObject({
    name: "api",
    workspace: "shop",
    dir: p.root,
    path: p.clone,
    description: "billing",
    workflow: "lean",
  });
});
