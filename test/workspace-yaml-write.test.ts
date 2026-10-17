import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createWorkspaceDir } from "../src/discord-setup/workspace-template";
import { withMemoryLock } from "../src/memory/memory-file-lock";
import { inspectLocation } from "../src/workspaces/location-candidate";
import { registerLocation } from "../src/workspaces/register-location";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addLocationEntry, updateWorkspaceYaml } from "../src/workspaces/workspace-yaml-write";
import { assertTempHome } from "./helpers";

const CH = "100000000000000001";

/** Temp owner home + AGENT_HOME with space `w` holding channel CH; `yaml` replaces the channel's extra keys. */
function setup(channelExtra: Record<string, unknown> = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "friday-yw-")));
  const userHome = join(base, "user");
  const home = join(userHome, ".friday");
  mkdirSync(home, { recursive: true });
  assertTempHome(home);
  createWorkspaceDir(home, "w");
  const { config } = workspacePaths(home).workspace("w");
  writeFileSync(
    config,
    `# a comment\ndescription: shop\nskills:\n  extra: true\nchannels:\n  - id: "${CH}"\n    name: c\n    mode: task\n${Object.entries(
      channelExtra,
    )
      .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}\n`)
      .join("")}`,
  );
  const proj = join(base, "proj", "shop");
  mkdirSync(proj, { recursive: true });
  return { home, userHome, config, proj };
}

/** Inspect `path` (must be ok) and register it. */
function register(s: ReturnType<typeof setup>, path: string) {
  const cand = inspectLocation(s.home, "w", path, s.userHome);
  if (!cand.ok) throw new Error(cand.reason);
  return registerLocation(s.home, "w", CH, cand, s.userHome);
}
const channelOf = (s: ReturnType<typeof setup>) =>
  (Bun.YAML.parse(readFileSync(s.config, "utf8")) as any).channels[0];

test("registerLocation: absent locations key stays absent, other keys kept, backup made", () => {
  const s = setup();
  const r = register(s, s.proj);
  expect(r).toEqual({ ok: true, name: "shop", added: true, linked: true });
  const data = Bun.YAML.parse(readFileSync(s.config, "utf8")) as any;
  expect(data.description).toBe("shop");
  expect(data.skills).toEqual({ extra: true });
  expect(data.locations).toEqual([{ name: "shop", path: s.proj, description: "shop" }]);
  expect(channelOf(s).locations).toBeUndefined();
  expect(readFileSync(s.config, "utf8")).not.toContain("# a comment"); // comments are dropped (documented)
  const backups = readdirSync(join(s.home, "backups", "persona", "w"));
  expect(backups.some((f) => f.startsWith("workspace.yaml-"))).toBe(true);
  expect(loadWorkspaces(s.home, s.userHome).workspaces[0]?.locations.map((l) => l.name)).toEqual([
    "shop",
  ]);
});

test("registerLocation: explicit list gets the name, [] becomes [name], existing path only links", () => {
  const s = setup({ locations: [] });
  expect(register(s, s.proj)).toMatchObject({ ok: true, added: true });
  expect(channelOf(s).locations).toEqual(["shop"]);
  // Same path again: no new entry, no duplicate link.
  expect(register(s, s.proj)).toMatchObject({ ok: true, name: "shop", added: false });
  expect(channelOf(s).locations).toEqual(["shop"]);
  const other = join(dirname(dirname(s.proj)), "proj", "blog");
  mkdirSync(other);
  register(s, other);
  expect(channelOf(s).locations).toEqual(["shop", "blog"]);
});

test("registerLocation refuses an unknown channel and restores the file when the registry rejects", () => {
  const s = setup();
  const cand = inspectLocation(s.home, "w", s.proj, s.userHome);
  if (!cand.ok) throw new Error(cand.reason);
  const before = readFileSync(s.config, "utf8");
  expect(registerLocation(s.home, "w", "999999999999999999", cand, s.userHome)).toEqual({
    ok: false,
    reason: "channel is not mapped in this space",
  });
  expect(readFileSync(s.config, "utf8")).toBe(before);
  // Verify failure: the writer puts the old bytes back.
  const reason = updateWorkspaceYaml(
    s.home,
    "w",
    (d) => {
      addLocationEntry(d, { name: "x", path: s.proj, description: "" });
      return undefined;
    },
    { verify: () => "nope" },
  );
  expect(reason).toBe("nope");
  expect(readFileSync(s.config, "utf8")).toBe(before);
  expect(readdirSync(dirname(s.config)).some((f) => f.endsWith(".tmp"))).toBe(false);
});

test("writers are serialised by the lock: parallel processes lose no update", async () => {
  const s = setup();
  const code = (i: number) =>
    `import { addWorkspaceChannel } from "${join(import.meta.dir, "../src/discord-setup/workspace-template")}";` +
    `addWorkspaceChannel(${JSON.stringify(s.home)}, "w", { id: "10000000000000010${i}", name: "c${i}", mode: "task" });`;
  const procs = [1, 2, 3, 4].map((i) =>
    Bun.spawn(["bun", "-e", code(i)], { stdout: "ignore", stderr: "pipe" }),
  );
  const codes = await Promise.all(procs.map((p) => p.exited));
  expect(codes).toEqual([0, 0, 0, 0]);
  const data = Bun.YAML.parse(readFileSync(s.config, "utf8")) as any;
  expect(data.channels).toHaveLength(5);
});

test("a busy lock refuses without writing", () => {
  const s = setup();
  const before = readFileSync(s.config, "utf8");
  withMemoryLock(s.config, () => {
    expect(() => updateWorkspaceYaml(s.home, "w", () => undefined, { waitMs: 100 })).toThrow(
      "busy",
    );
  });
  expect(readFileSync(s.config, "utf8")).toBe(before);
  // The lock is released afterwards: a later register works.
  expect(register(s, s.proj)).toMatchObject({ ok: true });
});

test("a throwing verify still restores the old bytes, and no temp file stays", () => {
  const s = setup();
  const before = readFileSync(s.config, "utf8");
  expect(() =>
    updateWorkspaceYaml(
      s.home,
      "w",
      (d) => {
        addLocationEntry(d, { name: "x", path: s.proj, description: "" });
        return undefined;
      },
      {
        backupAt: new Date(),
        verify: () => {
          throw new Error("boom");
        },
      },
    ),
  ).toThrow("boom");
  expect(readFileSync(s.config, "utf8")).toBe(before);
  expect(readdirSync(dirname(s.config)).some((f) => f.endsWith(".tmp"))).toBe(false);
  // The backup holds the old bytes.
  const dirBk = join(s.home, "backups", "persona", "w");
  const [bk] = readdirSync(dirBk);
  expect(readFileSync(join(dirBk, bk as string), "utf8")).toBe(before);
});
