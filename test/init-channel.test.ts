import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType } from "discord.js";
import { parseSlash } from "../src/commands/slash-commands";
import { SLASH_DEFINITIONS, slashPayload, slashText } from "../src/commands/slash-definitions";
import { workspacePaths } from "../src/config/workspace-paths";
import {
  ADMIN_ONLY_CONTROL,
  isAdminText,
  parseAdminCommand,
} from "../src/discord-setup/admin-command";
import { createAdminHandler } from "../src/discord-setup/admin-handler";
import { CHAT_TOPIC, channelTopic, TASK_TOPIC } from "../src/discord-setup/channel-topic";
import { initChannel } from "../src/discord-setup/init-channel";
import {
  createPrivate,
  findExisting,
  privateOverwrites,
} from "../src/discord-setup/private-channels";
import { addWorkspaceChannel, createWorkspaceDir } from "../src/discord-setup/workspace-template";
import { type FakeChannel, fakeGuild } from "./fake-guild";
import { assertTempHome } from "./helpers";

const ids = { guildId: "G1", ownerId: "OWN", botId: "BOT" };
const CAT = "800000000000000001";
const FIRST = "800000000000000002";

/** A temp home with a set-up space `personal` (category CAT, `#personal-agent` = FIRST). */
function setup(extra: FakeChannel[] = [], opts = {}) {
  const home = mkdtempSync(join(tmpdir(), "friday-initch-"));
  assertTempHome(home);
  createWorkspaceDir(home, "personal");
  addWorkspaceChannel(home, "personal", { id: FIRST, name: "personal-agent", mode: "task" });
  const g = fakeGuild(
    [
      { id: CAT, name: "personal", type: ChannelType.GuildCategory, parentId: null },
      { id: FIRST, name: "personal-agent", type: ChannelType.GuildText, parentId: CAT },
      ...extra,
    ],
    opts,
  );
  return { home, ...g, deps: { home, guild: g.guild, ids } };
}
const yaml = (home: string) =>
  Bun.YAML.parse(readFileSync(workspacePaths(home).workspace("personal").config, "utf8")) as any;

test("success: private channel under the category, yaml, memory dir, topic", async () => {
  const s = setup();
  const reply = await initChannel(s.deps, "personal", "finance");
  expect(reply).toContain("Created private");
  expect(s.created).toHaveLength(1);
  expect(s.created[0].parent).toBe(CAT);
  expect(s.created[0].permissionOverwrites).toEqual(privateOverwrites(ids));
  const id = s.created[0].id;
  expect(yaml(s.home).channels).toEqual([
    { id: FIRST, name: "personal-agent", mode: "task" },
    { id, name: "finance", mode: "task" },
  ]);
  const dir = workspacePaths(s.home).workspace("personal").channel("finance");
  expect(existsSync(dir.memory)).toBe(true);
  expect(s.topics[id]).toBe(TASK_TOPIC);
});

test("rerun is refused: nothing more is created", async () => {
  const s = setup();
  await initChannel(s.deps, "personal", "finance");
  expect(await initChannel(s.deps, "personal", "finance")).toContain("already");
  expect(s.created).toHaveLength(1);
});

test("same name in another category is NOT adopted: a new channel is created", async () => {
  const other: FakeChannel = {
    id: "7",
    name: "finance",
    type: ChannelType.GuildText,
    parentId: "OTHERCAT",
  };
  const s = setup([other]);
  expect(await initChannel(s.deps, "personal", "finance")).toContain("Created");
  expect(s.created).toHaveLength(1);
  expect(s.created[0].parent).toBe(CAT);
  const ids2 = yaml(s.home).channels.map((c: any) => c.id);
  expect(ids2).not.toContain("7");
  expect(ids2).toContain(s.created[0].id);
  expect(s.topics["7"]).toBeUndefined(); // the foreign channel is never edited
});

test("same name in the category is refused", async () => {
  const dup: FakeChannel = { id: "8", name: "finance", type: ChannelType.GuildText, parentId: CAT };
  const s = setup([dup]);
  expect(await initChannel(s.deps, "personal", "finance")).toContain("already exists");
  expect(s.created).toHaveLength(0);
  expect(findExisting([dup], "FINANCE", ChannelType.GuildText, CAT)).toBeDefined();
  expect(findExisting([dup], "finance", ChannelType.GuildText, "X")).toBeUndefined();
});

test("createPrivate with parentId ignores other categories; without it stays guild-wide", async () => {
  const other: FakeChannel = { id: "7", name: "x", type: ChannelType.GuildText, parentId: "O" };
  const g = fakeGuild([other]);
  const list = [...g.channels.values()];
  expect(await createPrivate(g.guild, list, { name: "x", kind: "text" }, ids)).toEqual({
    status: "exists",
    id: "7",
  });
  const r = await createPrivate(g.guild, list, { name: "x", kind: "text", parentId: CAT }, ids);
  expect(r.status).toBe("created");
});

test("refuses when the first channel is not in a category named like the space", async () => {
  const s = setup();
  s.channels.set(CAT, { id: CAT, name: "other", type: ChannelType.GuildCategory, parentId: null });
  expect(await initChannel(s.deps, "personal", "finance")).toContain("not in a category named");
  s.channels.set(CAT, { id: CAT, name: "personal", type: ChannelType.GuildText, parentId: null });
  expect(await initChannel(s.deps, "personal", "finance")).toContain("not in a category named");
  expect(s.created).toHaveLength(0);
  expect(yaml(s.home).channels).toHaveLength(1);
});

test("refuses a missing space, a space without channels and a vanished first channel", async () => {
  const s = setup();
  expect(await initChannel(s.deps, "nope", "x")).toContain("missing or not set up");
  createWorkspaceDir(s.home, "empty");
  expect(await initChannel(s.deps, "empty", "x")).toContain("not set up");
  s.channels.delete(FIRST);
  expect(await initChannel(s.deps, "personal", "x")).toContain("Cannot find the category");
  expect(s.created).toHaveLength(0);
});

test("refuses a name already in the yaml", async () => {
  const s = setup();
  expect(await initChannel(s.deps, "personal", "personal-agent")).toContain("already a channel");
});

test("partial failure after create names the channel; topic failure does not fail", async () => {
  const s = setup([], { failEdit: true });
  expect(await initChannel(s.deps, "personal", "finance")).toContain("Created");
  const bad = setup();
  // A corrupt yaml makes the append throw after the channel exists.
  const { config } = workspacePaths(bad.home).workspace("personal");
  await Bun.write(config, "channels:\n  - 1234567890123456789\n");
  const r = await initChannel({ ...bad.deps }, "personal", "x");
  expect(r).toContain("not set up"); // unreadable yaml is "foreign": refused before any Discord call
  expect(bad.created).toHaveLength(0);
});

test("Discord failure on create: error reply, nothing in yaml", async () => {
  const s = setup([], { failCreateAt: 1 });
  expect(await initChannel(s.deps, "personal", "finance")).toContain("Setup failed");
  expect(yaml(s.home).channels).toHaveLength(1);
});

test("a throw after create names the channel in the reply", async () => {
  const s = setup();
  const orig = s.guild.channels.create;
  // Break the yaml append: make the dir read-only is fragile, so fail the topic path via ensure... use a bad space dir instead.
  s.guild.channels.create = async (o: any) => {
    const r = await orig(o);
    await Bun.write(workspacePaths(s.home).workspace("personal").config, "channels: [1]\n");
    return r;
  };
  const reply = await initChannel(s.deps, "personal", "finance");
  expect(reply).toContain("Setup failed");
  expect(reply).toContain("exists");
  expect(reply).toContain(s.created[0].id);
});

// --- admin command parsing / slash / topic ---
test("parse /init-channel", () => {
  expect(parseAdminCommand("/init-channel personal/finance")).toEqual({
    kind: "init_channel",
    space: "personal",
    name: "finance",
  });
  for (const bad of [
    "personal",
    "personal/",
    "/x",
    "Pers/x",
    "a/B",
    "a/b/c",
    "a/ops-control",
    "a/-x",
  ])
    expect(parseAdminCommand(`/init-channel ${bad}`).kind).toBe("invalid_name");
  expect(isAdminText("/init-channel a/b")).toBe(true);
  expect(isAdminText("init:channel:a/b")).toBe(false);
  expect(isAdminText("please /init-channel a/b")).toBe(false);
  expect(parseAdminCommand("hello")).toMatchObject({ kind: "help" });
  expect((parseAdminCommand("hello") as any).reply).toContain("/init-channel");
});

test("slash definition: one required arg `path`", () => {
  expect(SLASH_DEFINITIONS["init-channel"].arg).toMatchObject({
    name: "path",
    required: true,
  });
  expect(slashPayload().find((c) => c.name === "init-channel")?.options).toHaveLength(1);
  expect(slashText("init-channel", (a) => (a === "path" ? "personal/finance" : null))).toBe(
    "/init-channel personal/finance",
  );
  expect(parseSlash("/init-channel personal/finance")).toEqual({
    name: "init-channel",
    arg: "personal/finance",
  });
});

test("channelTopic per mode", () => {
  expect(channelTopic("task")).toBe(TASK_TOPIC);
  expect(channelTopic("chat")).toBe(CHAT_TOPIC);
  expect(TASK_TOPIC).toBe("🧵 task: @Friday để mở thread");
  expect(CHAT_TOPIC).toBe("💬 chat: nhắn thẳng, không cần @Friday");
});

// --- the admin gate in front of the command ---
/** A fake control message; `ch` overrides the channel facts. */
function fakeMsg(guild: any, ch: { id?: string; thread?: boolean; priv?: boolean } = {}) {
  const replies: string[] = [];
  const cache =
    (ch.priv ?? true)
      ? privateOverwrites(ids).map((o) => ({
          id: o.id,
          type: o.type,
          allow: { bitfield: o.allow },
          deny: { bitfield: o.deny },
        }))
      : [];
  const msg: any = {
    guild,
    guildId: "G1",
    channel: {
      id: ch.id ?? "CTRL",
      isThread: () => !!ch.thread,
      permissionOverwrites: { cache: { values: () => cache.values() } },
    },
    reply: async (o: any) => void replies.push(o.content),
  };
  return { msg, replies };
}
const handler = (home: string) =>
  createAdminHandler({
    home,
    guildId: "G1",
    ownerId: "OWN",
    botId: () => "BOT",
    setup: { controlChannels: ["CTRL"], ops: {} } as any,
  });

test("gate: refused outside #ops-control, in a thread, in a public channel; no side effects", async () => {
  const s = setup();
  for (const ch of [{ id: "OTHER" }, { thread: true }, { priv: false }]) {
    const { msg, replies } = fakeMsg(s.guild, ch);
    await handler(s.home)(msg, "/init-channel personal/finance");
    expect(replies[0]).toMatch(new RegExp(`${ADMIN_ONLY_CONTROL}|not private`));
  }
  expect(s.created).toHaveLength(0);
});

test("gate: bad name replies before Discord; good name runs", async () => {
  const s = setup();
  const bad = fakeMsg(s.guild);
  await handler(s.home)(bad.msg, "/init-channel personal/Bad Name");
  expect(bad.replies[0]).toContain("Channel name");
  expect(s.created).toHaveLength(0);
  const good = fakeMsg(s.guild);
  await handler(s.home)(good.msg, "/init-channel personal/finance");
  expect(good.replies[0]).toContain("Created private");
});
