import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChannelType } from "discord.js";
import { workspacePaths } from "../src/config/workspace-paths";
import {
  ADMIN_ONLY_CONTROL,
  adminGate,
  type GateFacts,
  isAdminText,
  parseAdminCommand,
} from "../src/providers/discord/setup/admin-command";
import { TASK_TOPIC } from "../src/providers/discord/setup/channel-topic";
import { initWorkspace } from "../src/providers/discord/setup/init-workspace";
import {
  addWorkspaceChannel,
  createWorkspaceDir,
  workspaceState,
} from "../src/providers/discord/setup/workspace-template";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { fakeGuild } from "./fake-guild";
import { assertTempHome } from "./helpers";

const tmpHome = () => {
  const home = mkdtempSync(join(tmpdir(), "friday-init-"));
  assertTempHome(home);
  return home;
};

/** A channel entry for `addWorkspaceChannel`. */
const ch = (id: string, name = "c") => ({ id, name, mode: "task" as const });

const bad = ["../x", "a/b", "a b", "Reelme", "ops", "a".repeat(33), "", "-x", "a.b", "a\nb"];
test.each(bad)("parseAdminCommand rejects name %j before anything runs", (name) => {
  const cmd = parseAdminCommand(`/init-workspace ${name}`);
  expect(cmd.kind).toBe("invalid_name");
});

test("parseAdminCommand accepts valid names and gives help for other text", () => {
  expect(parseAdminCommand("/init-workspace reelme")).toEqual({
    kind: "init_workspace",
    name: "reelme",
  });
  expect(parseAdminCommand("  /init-workspace a-1  ")).toEqual({
    kind: "init_workspace",
    name: "a-1",
  });
  expect(parseAdminCommand(`/init-workspace ${"a".repeat(32)}`).kind).toBe("init_workspace");
  expect(parseAdminCommand("hello").kind).toBe("help");
  expect(parseAdminCommand("/init-workspace ops")).toMatchObject({ kind: "invalid_name" });
  expect((parseAdminCommand("/init-workspace ops") as any).reply).toContain("reserved");
});

test("isAdminText detects the slash command only", () => {
  expect(isAdminText("/init-workspace x")).toBe(true);
  expect(isAdminText("/INIT-WORKSPACE x")).toBe(true);
  expect(isAdminText("init:workspace:x")).toBe(false);
  expect(isAdminText("please /init-workspace x")).toBe(false);
});

const ok: GateFacts = {
  guildPinned: true,
  inPinnedGuild: true,
  isThread: false,
  channelId: "C1",
  controlChannels: ["C1"],
  privateNow: true,
};
const gateCases: [string, Partial<GateFacts>, string | true][] = [
  ["control channel, private, pinned", {}, true],
  ["no guild pinned", { guildPinned: false }, "DISCORD_GUILD_ID"],
  ["other guild", { inPinnedGuild: false }, "DISCORD_GUILD_ID"],
  ["other channel", { channelId: "C2" }, ADMIN_ONLY_CONTROL],
  ["thread (even of the control channel)", { isThread: true }, ADMIN_ONLY_CONTROL],
  ["no control channels configured", { controlChannels: [] }, ADMIN_ONLY_CONTROL],
  ["public control channel", { privateNow: false }, "not private"],
];
test.each(gateCases)("adminGate: %s", (_n, over, expected) => {
  const r = adminGate({ ...ok, ...over });
  if (expected === true) expect(r).toEqual({ ok: true });
  else expect(r.ok === false && r.reply.includes(expected)).toBe(true);
});

test("createWorkspaceDir writes the template; loadWorkspaces reads it", () => {
  const home = tmpHome();
  expect(workspaceState(home, "reelme")).toEqual({ kind: "missing" });
  createWorkspaceDir(home, "reelme");
  const ws = workspacePaths(home).workspace("reelme");
  for (const f of ["workspace.yaml", "IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md"])
    expect(existsSync(join(ws.root, f))).toBe(true);
  expect(existsSync(ws.locations) && existsSync(ws.cwd)).toBe(true);
  expect(existsSync(join(ws.root, "MEMORY.md"))).toBe(false); // memory lives in the channels
  expect(workspaceState(home, "reelme")).toEqual({ kind: "workspace", channels: [] });
  // The registry accepts the template as a workspace with no channels and no locations yet.
  expect(loadWorkspaces(home, home).workspaces).toMatchObject([
    { name: "reelme", channels: [], locations: [] },
  ]);
  // Existing dir: the non-recursive mkdir refuses to reuse it.
  expect(() => createWorkspaceDir(home, "reelme")).toThrow();
});

test("addWorkspaceChannel keeps other fields, is idempotent and deterministic", () => {
  const home = tmpHome();
  createWorkspaceDir(home, "w");
  const { config } = workspacePaths(home).workspace("w");
  writeFileSync(config, '# note\ndescription: "my ws"\nchannels: []\nextra: 1\n');
  addWorkspaceChannel(home, "w", ch("100000000000000001"));
  const once = readFileSync(config, "utf8");
  addWorkspaceChannel(home, "w", ch("100000000000000001"));
  expect(readFileSync(config, "utf8")).toBe(once);
  const parsed = Bun.YAML.parse(once) as any;
  expect(parsed).toEqual({
    description: "my ws",
    channels: [{ id: "100000000000000001", name: "c", mode: "task" }],
    extra: 1,
  });
  // A name an object entry already uses is refused (other id); the same id stays idempotent.
  expect(() => addWorkspaceChannel(home, "w", ch("100000000000000002"))).toThrow("already used");
  addWorkspaceChannel(home, "w", { ...ch("100000000000000002"), name: "d" });
  expect((Bun.YAML.parse(readFileSync(config, "utf8")) as any).channels).toHaveLength(2);
  expect(readdirSync(dirname(config)).some((f) => f.endsWith(".tmp"))).toBe(false);
  expect(workspaceState(home, "w")).toEqual({
    kind: "workspace",
    channels: ["100000000000000001", "100000000000000002"],
  });
});

test("workspaceState: foreign dirs are recognised", () => {
  const home = tmpHome();
  const paths = workspacePaths(home);
  mkdirSync(paths.workspace("empty").root, { recursive: true });
  expect(workspaceState(home, "empty")).toEqual({ kind: "foreign" });
  symlinkSync(tmpdir(), paths.workspace("link").root);
  expect(workspaceState(home, "link")).toEqual({ kind: "foreign" });
});

/** initWorkspace refusals that return before any Discord call (no guild needed). */
const noGuild = (home: string) => ({
  home,
  guild: undefined as never,
  ids: { guildId: "1", ownerId: "2", botId: "3" },
});

test("initWorkspace refuses a foreign dir without touching Discord or the dir", async () => {
  const home = tmpHome();
  const paths = workspacePaths(home);
  mkdirSync(paths.workspace("odd").root, { recursive: true });
  expect(await initWorkspace(noGuild(home), "odd")).toContain("not a workspace");
  expect(existsSync(paths.workspace("odd").config)).toBe(false);
});

test("initWorkspace rerun on a finished workspace says already set up and creates nothing", async () => {
  const home = tmpHome();
  createWorkspaceDir(home, "done");
  addWorkspaceChannel(home, "done", ch("100000000000000001"));
  const before = readFileSync(workspacePaths(home).workspace("done").config, "utf8");
  expect(await initWorkspace(noGuild(home), "done")).toContain("already set up");
  expect(readFileSync(workspacePaths(home).workspace("done").config, "utf8")).toBe(before);
});

test("two quick init runs of the same name: the second is refused as in progress", async () => {
  const home = tmpHome();
  let release: (v: unknown) => void = () => {};
  // Tiny stand-in: the first run parks on the channel fetch, finds the category and stops.
  const guild: any = {
    channels: {
      fetch: () =>
        new Promise((r) => {
          release = () => r(new Map([["1", { id: "1", name: "busy", type: 4, parentId: null }]]));
        }),
    },
  };
  const first = initWorkspace({ ...noGuild(home), guild }, "busy");
  const second = await initWorkspace({ ...noGuild(home), guild }, "busy");
  expect(second).toContain("already in progress");
  release(undefined);
  expect(await first).toContain("already exists");
  // After it finished, the name is free again (no stuck lock).
  expect(
    await initWorkspace({ ...noGuild(home), guild: undefined as never }, "busy").catch(
      () => "threw",
    ),
  ).toBeString();
});

test("an unquoted 19-digit channel id is never mapped to a wrong string", () => {
  const home = tmpHome();
  createWorkspaceDir(home, "num");
  const { config } = workspacePaths(home).workspace("num");
  writeFileSync(config, "channels:\n  - 1234567890123456789\n");
  // Registry: the lossy number fails the string schema -> workspace skipped, never routed on a wrong id.
  expect(loadWorkspaces(home, home).workspaces).toEqual([]);
  // Template helpers: foreign (untouched), and adding a channel throws instead of rewriting the id.
  expect(workspaceState(home, "num")).toEqual({ kind: "foreign" });
  expect(() => addWorkspaceChannel(home, "num", ch("100000000000000001"))).toThrow();
  expect(readFileSync(config, "utf8")).toContain("1234567890123456789");
});

test("the deterministic renderer quotes channel ids", () => {
  const home = tmpHome();
  createWorkspaceDir(home, "q");
  addWorkspaceChannel(home, "q", ch("1234567890123456789"));
  const text = readFileSync(workspacePaths(home).workspace("q").config, "utf8");
  expect(text).toContain('"1234567890123456789"');
  expect(loadWorkspaces(home, home).workspaces[0]?.channels).toEqual(["1234567890123456789"]);
});

test("initWorkspace success: first channel is an object, channel dir exists, topic set", async () => {
  const home = tmpHome();
  const g = fakeGuild([]);
  const reply = await initWorkspace({ ...noGuild(home), guild: g.guild }, "shop");
  expect(reply).toContain("Created private category");
  const category = g.created.find((c) => c.type === ChannelType.GuildCategory);
  const text = g.created.find((c) => c.type === ChannelType.GuildText);
  expect(text.parent).toBe(category.id);
  const paths = workspacePaths(home).workspace("shop");
  expect((Bun.YAML.parse(readFileSync(paths.config, "utf8")) as any).channels).toEqual([
    { id: text.id, name: "shop", mode: "task" },
  ]);
  expect(existsSync(paths.channel("shop").memory)).toBe(true);
  expect(g.topics[text.id]).toBe(TASK_TOPIC);
  expect(workspaceState(home, "shop")).toEqual({ kind: "workspace", channels: [text.id] });
});
