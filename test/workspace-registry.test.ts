import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addLocation, defaultLocationPath, makeEnv, outsideDir } from "./helpers";

const CH1 = "11111111111111111";
const CH2 = "22222222222222222";

/** Scenario: builds fixtures under a temp home, then names what the scan must return. */
interface Case {
  name: string;
  /** Returns the fake $HOME to scan with (default: the real one). */
  setup: (env: ReturnType<typeof makeEnv>) => string | undefined | void;
  /** Loaded workspaces as `ws:location,location|ws2`. */
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

/** Write a bare `workspace.yaml` (no locations) for a workspace dir name, whatever the name. */
const rawWorkspace = (home: string, name: string, yaml = "channels: []\n"): void => {
  const root = join(home, "workspaces", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "workspace.yaml"), yaml);
};

const cases: Case[] = [
  {
    name: "valid workspaces with locations, sorted",
    setup: ({ home }) => {
      addLocation(home, "api", {}, { workspace: "shop" });
      addLocation(home, "web", {}, { workspace: "shop" });
      addLocation(home, "cli", {}, { workspace: "alpha", channels: [CH1] });
    },
    loaded: ["alpha:cli", "shop:api,web"],
    channels: { alpha: [CH1], shop: [] },
  },
  {
    name: "legacy dir (config.yaml, no workspace.yaml) is listed and never loaded",
    setup: ({ home }) => {
      addLocation(home, "api", {}, { workspace: "main" });
      const old = join(home, "workspaces", "oldlocation");
      mkdirSync(join(old, "location", ".git"), { recursive: true });
      writeFileSync(join(old, "config.yaml"), `path: ${join(old, "location")}\n`);
    },
    loaded: ["main:api"],
    legacy: ["oldlocation"],
  },
  {
    name: "symlinked workspace dir is skipped",
    setup: ({ home }) => {
      addLocation(home, "api", {}, { workspace: "real" });
      symlinkSync(join(home, "workspaces", "real"), join(home, "workspaces", "link"));
    },
    loaded: ["real:api"],
  },
  {
    name: "symlinked location dir is skipped",
    setup: ({ home }) => {
      addLocation(home, "api", {}, { workspace: "main" });
      symlinkSync(
        workspacePaths(home).workspace("main").location("api").root,
        join(home, "workspaces", "main", "locations", "alias"),
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
      addLocation(home, "a", {}, { workspace: "one", channels: [CH1, CH2] });
      addLocation(home, "b", {}, { workspace: "two", channels: [CH1] });
    },
    loaded: ["one:a", "two:b"],
    channels: { one: [CH2], two: [] },
  },
  {
    name: "bad location names are skipped; a plain directory (no git) is a valid location",
    setup: ({ home }) => {
      addLocation(home, "good", {}, { workspace: "main" });
      addLocation(home, ".hidden", {}, { workspace: "main" });
      addLocation(home, "has space", {}, { workspace: "main" });
      const notgit = outsideDir();
      addLocation(home, "plain", {}, { workspace: "main", path: notgit });
    },
    loaded: ["main:good,plain"],
  },
  {
    name: "location path equal to AGENT_HOME is skipped",
    setup: ({ home }) => {
      mkdirSync(join(home, ".git"));
      addLocation(home, "all", {}, { workspace: "main", path: home });
      addLocation(home, "fine", {}, { workspace: "main" });
    },
    loaded: ["main:fine"],
  },
  {
    name: "location path above $HOME (an ancestor) is skipped",
    setup: ({ home }) => {
      const top = fakeGit(join(home, "top"));
      const me = join(top, "sub", "me");
      mkdirSync(me, { recursive: true });
      addLocation(home, "anc", {}, { workspace: "main", path: top });
      return me;
    },
    loaded: ["main:"],
  },
  {
    name: "location path equal to $HOME is skipped",
    setup: ({ home }) => {
      const fakeHome = fakeGit(join(home, "fakehome"));
      addLocation(home, "tilde", {}, { workspace: "main", path: fakeHome });
      return fakeHome;
    },
    loaded: ["main:"],
  },
  {
    name: "overlapping location paths across workspaces are both kept (warning only)",
    setup: ({ home }) => {
      const shared = fakeGit(join(outsideDir(), "shared"));
      addLocation(home, "a", {}, { workspace: "one", path: shared });
      addLocation(home, "b", {}, { workspace: "two", path: shared });
    },
    loaded: ["one:a", "two:b"],
  },
];

test.each(cases)("loadWorkspaces: $name", (c) => {
  const env = makeEnv();
  // Start from an empty registry (makeEnv seeds one location for other suites).
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const scan = loadWorkspaces(env.home, c.setup(env) ?? undefined);
  expect(
    scan.workspaces.map((w) => `${w.name}:${w.locations.map((r) => r.name).join(",")}`),
  ).toEqual(c.loaded);
  expect(scan.legacy).toEqual(c.legacy ?? []);
  for (const [ws, channels] of Object.entries(c.channels ?? {}))
    expect(scan.workspaces.find((w) => w.name === ws)?.channels).toEqual(channels);
});

test("loadWorkspaces: missing workspaces dir gives an empty scan", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  expect(loadWorkspaces(env.home)).toEqual({ workspaces: [], legacy: [], needsMigration: [] });
});

test("loaded locations carry workspace name, absolute path, description and the computed git flag", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  addLocation(env.home, "api", { description: "billing" }, { workspace: "shop" });
  addLocation(env.home, "docs", {}, { workspace: "shop", git: false });
  const [api, docs] = loadWorkspaces(env.home).workspaces[0]!.locations;
  expect(api).toMatchObject({
    name: "api",
    workspace: "shop",
    path: defaultLocationPath(env.home, "api", "shop"),
    description: "billing",
    git: true,
  });
  expect(docs?.git).toBe(false); // a plain directory is a valid location
});

test("workspace.yaml locations: legacy keys, bad names and duplicates are skipped", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  const dir = join(outsideDir(), "somewhere");
  mkdirSync(dir, { recursive: true });
  rawWorkspace(
    env.home,
    "w",
    `locations:
  - {name: ok, path: ${dir}}
  - {name: legacy, path: ${dir}, testCommand: x}
  - {name: "bad name", path: ${dir}}
  - {name: ok, path: ${dir}}
  - {name: gone, path: ${join(env.home, "missing")}}
`,
  );
  const w = loadWorkspaces(env.home).workspaces[0]!;
  expect(w.locations.map((l) => l.name)).toEqual(["ok"]);
});

test("channel objects and legacy plain ids are both parsed; skills.extra stays valid", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  rawWorkspace(
    env.home,
    "w",
    `channels:
  - "${CH1}"
  - {id: "${CH2}", name: chat-room, mode: chat, locations: [api]}
skills:
  extra: [a]
`,
  );
  const w = loadWorkspaces(env.home).workspaces[0]!;
  expect(w.channels).toEqual([CH1, CH2]);
  expect(w.channelDefs).toEqual([
    { id: CH1, name: "w-agent", mode: "task" },
    { id: CH2, name: "chat-room", mode: "chat", locations: ["api"] },
  ]);
});

test("a workspace with repos/<n>/repo.yaml is reported in needsMigration", () => {
  const env = makeEnv();
  rmSync(workspacePaths(env.home).workspaces, { recursive: true, force: true });
  rawWorkspace(env.home, "old");
  mkdirSync(join(env.home, "workspaces", "old", "repos", "api"), { recursive: true });
  writeFileSync(join(env.home, "workspaces", "old", "repos", "api", "repo.yaml"), "path: /x\n");
  expect(loadWorkspaces(env.home).needsMigration).toEqual(["old"]);
});
