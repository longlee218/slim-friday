import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType } from "discord.js";
import { workspacePaths } from "../src/config/workspace-paths";
import { privateOverwrites } from "../src/discord-setup/private-channels";
import { addWorkspaceChannel, createWorkspaceDir } from "../src/discord-setup/workspace-template";
import { createChannelAdopter } from "../src/ingress/channel-adoption";
import { createMessageHandler, type InboundMessage } from "../src/ingress/discord-message-handler";
import { BUSY_ACK_EMOJI } from "../src/ingress/discord-send";
import { assertTempHome } from "./helpers";

const OWNER = "111";
const BOT = "999";
const GUILD = "G1";
const CAT = "800000000000000001";
const FIRST = "800000000000000002";
const OPS = "800000000000000099";

/** Guild with category `demo` holding the space's first channel; extra channels are added per test. */
function world() {
  const home = mkdtempSync(join(tmpdir(), "friday-adoptsc-"));
  assertTempHome(home);
  createWorkspaceDir(home, "demo");
  addWorkspaceChannel(home, "demo", { id: FIRST, name: "demo-agent", mode: "task" });
  const cache = new Map<string, any>([
    [CAT, { id: CAT, name: "demo", type: ChannelType.GuildCategory, parentId: null }],
    [FIRST, { id: FIRST, name: "demo-agent", type: ChannelType.GuildText, parentId: CAT }],
  ]);
  const topics: Record<string, string> = {};
  const guild: any = {
    id: GUILD,
    channels: {
      cache,
      edit: async (id: string, o: any) => {
        topics[id] = o.topic;
      },
    },
  };
  const messages: InboundMessage[] = [];
  const handler = (home2 = home, receiptDelayMs?: number, slow = 0) => {
    const adopt = createChannelAdopter({
      home: home2,
      ownerId: OWNER,
      guildId: GUILD,
      botId: () => BOT,
      ops: new Set([OPS]),
    });
    return createMessageHandler({
      receiptDelayMs,
      ownerId: OWNER,
      botId: () => BOT,
      guildId: GUILD,
      handleMessage: async (m) => {
        messages.push(m);
        return "answer";
      },
      setup: { controlChannels: [], ops: { log: OPS } } as any,
      // `slow` delays the adopter so the busy-ack reaction (after receiptDelayMs) is already on the message.
      adoptChannel: async (m, visible) => {
        await new Promise((r) => setTimeout(r, slow));
        return adopt(m, visible);
      },
    });
  };
  return { home, guild, cache, topics, messages, handler };
}

let seq = 10;
/** A text channel (private unless told otherwise) registered in the guild cache. */
function textChannel(w: ReturnType<typeof world>, name: string, o: any = {}) {
  seq += 1;
  const id = `8000000000000001${seq}`;
  const overwrites = (
    o.open ? [] : privateOverwrites({ guildId: GUILD, ownerId: OWNER, botId: BOT })
  ).map((x) => ({ ...x, allow: { bitfield: x.allow }, deny: { bitfield: x.deny } }));
  const ch: any = {
    id,
    name,
    type: o.type ?? ChannelType.GuildText,
    parentId: o.parentId ?? CAT,
    guild: w.guild,
    permissionOverwrites: { cache: new Map(overwrites.map((x) => [x.id, x])) },
    sent: [] as any[],
    isThread: () => !!o.thread,
    isSendable: () => true,
    send: async (x: any) => void ch.sent.push(x),
    sendTyping: async () => {},
  };
  w.cache.set(id, ch);
  return ch;
}

/** Owner message; `startThread` / `reply` recorded. */
function message(w: ReturnType<typeof world>, ch: any, o: any = {}) {
  const thread: any = {
    id: "thr1",
    isThread: () => true,
    isSendable: () => true,
    ownerId: BOT,
    parentId: ch.id,
    send: async () => {},
    sendTyping: async () => {},
  };
  const calls = {
    reply: [] as any[],
    threads: [] as any[],
    reacted: [] as string[],
    removed: [] as number[],
  };
  const m: any = {
    id: "m1",
    author: { id: o.author ?? OWNER, bot: false },
    content: o.text ?? `<@${BOT}> hello, can you please check the status of my shop project today`,
    channel: ch,
    guild: w.guild,
    guildId: o.guildId ?? GUILD,
    inGuild: () => true,
    mentions: { has: () => o.mention ?? true },
    react: async (e: string) => void calls.reacted.push(e),
    reactions: {
      cache: new Map([
        [BUSY_ACK_EMOJI, { users: { remove: async () => void calls.removed.push(1) } }],
      ]),
    },
    reply: async (x: any) => void calls.reply.push(x),
    startThread: async (x: any) => {
      calls.threads.push(x);
      return thread;
    },
  };
  return { m, calls };
}
const channelsOf = (home: string) =>
  (Bun.YAML.parse(readFileSync(workspacePaths(home).workspace("demo").config, "utf8")) as any)
    .channels;

test("happy path: first mention adopts, thread opens, turn reaches handleMessage, second mention writes nothing", async () => {
  const w = world();
  const ch = textChannel(w, "Shop");
  const onMessage = w.handler();
  const x = message(w, ch);
  await onMessage(x.m);
  expect(channelsOf(w.home).at(-1)).toEqual({ id: ch.id, name: "shop", mode: "task" });
  expect(existsSync(workspacePaths(w.home).workspace("demo").channel("shop").memory)).toBe(true);
  expect(w.topics[ch.id]).toContain("task");
  expect(x.calls.reply[0].content).toContain("Linked #shop to the demo space");
  expect(x.calls.threads).toHaveLength(1);
  expect(w.messages).toHaveLength(1);
  const again = message(w, ch);
  await onMessage(again.m);
  expect(channelsOf(w.home)).toHaveLength(2);
  expect(again.calls.reply).toHaveLength(0);
  expect(w.messages).toHaveLength(2);
});

/** Run one message and assert nothing was written and no thread opened. */
async function untouched(w: ReturnType<typeof world>, ch: any, o: any = {}) {
  const x = message(w, ch, o);
  await w.handler()(x.m);
  expect(channelsOf(w.home)).toHaveLength(1);
  return x;
}

test("refusals: stranger, no literal mention, other guild", async () => {
  const w = world();
  const ch = textChannel(w, "shop");
  expect((await untouched(w, ch, { author: "222" })).calls.threads).toHaveLength(0);
  await untouched(w, ch, { text: "hello", mention: true }); // slash-like: mention flag without literal text
  await untouched(w, ch, { guildId: "OTHER" });
});

test("non-private channel is refused with a hint, no thread", async () => {
  const w = world();
  const x = await untouched(w, textChannel(w, "shop", { open: true }));
  expect(x.calls.reply[0].content).toContain("isn't private");
  expect(x.calls.threads).toHaveLength(0);
  expect(w.messages).toHaveLength(0);
});

test("unknown category, ops channel, thread: nothing adopted", async () => {
  const w = world();
  w.cache.set("700", { id: "700", name: "other", type: ChannelType.GuildCategory, parentId: null });
  await untouched(w, textChannel(w, "shop", { parentId: "700" }));
  const ops = textChannel(w, "ops-log");
  ops.id = OPS;
  await untouched(w, ops);
  const thread = textChannel(w, "t", { thread: true, type: ChannelType.PublicThread });
  await untouched(w, thread);
});

test("already mapped channel: no second write", async () => {
  const w = world();
  const ch = textChannel(w, "shop");
  addWorkspaceChannel(w.home, "demo", { id: ch.id, name: "shop", mode: "task" });
  await w.handler()(message(w, ch).m);
  expect(channelsOf(w.home)).toHaveLength(2);
});

test("two channels adopted one after the other and a slug collision get distinct names", async () => {
  const w = world();
  const a = textChannel(w, "Shop");
  const b = textChannel(w, "shop");
  const onMessage = w.handler();
  await onMessage(message(w, a).m);
  await onMessage(message(w, b).m);
  expect(
    channelsOf(w.home)
      .slice(1)
      .map((c: any) => c.name)
      .sort(),
  ).toEqual(["shop", "shop-2"]);
});

test("DM, forum and voice channels never adopt", async () => {
  const w = world();
  for (const type of [ChannelType.DM, ChannelType.GuildForum, ChannelType.GuildVoice])
    await untouched(w, textChannel(w, "shop", { type }));
});

test("non-ASCII channel name adopts with the fallback slug", async () => {
  const w = world();
  const ch = textChannel(w, "店舗🛒");
  await w.handler()(message(w, ch).m);
  expect(channelsOf(w.home).at(-1)).toEqual({
    id: ch.id,
    name: `channel-${ch.id.slice(-4)}`,
    mode: "task",
  });
});

test("a refusal clears the busy-ack reaction before returning", async () => {
  const w = world();
  const x = message(w, textChannel(w, "shop", { open: true }));
  await w.handler(w.home, 5, 40)(x.m); // adopter takes 40 ms, the reaction fires at 5 ms
  expect(x.calls.reacted).toEqual([BUSY_ACK_EMOJI]);
  expect(x.calls.removed).toHaveLength(1);
});

test("two channels adopted truly at once (Promise.all) get distinct names", async () => {
  const w = world();
  const [a, b] = [textChannel(w, "Shop"), textChannel(w, "shop")];
  const h = w.handler();
  await Promise.all([h(message(w, a).m), h(message(w, b).m)]);
  expect(
    new Set(
      channelsOf(w.home)
        .slice(1)
        .map((c: any) => c.name),
    ).size,
  ).toBe(2);
});
