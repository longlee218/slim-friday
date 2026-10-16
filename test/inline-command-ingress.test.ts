import { expect, test } from "bun:test";
import { OverwriteType } from "discord.js";
import { createAdminHandler } from "../src/discord-setup/admin-handler";
import { privateOverwrites } from "../src/discord-setup/private-channels";
import { createMessageHandler } from "../src/ingress/discord-message-handler";
import type { InlineRequest } from "../src/memory/find-command-handler";

const OWNER = "111";
const BOT = "999";
const OPS = "700000000000000001";
const CTRL = "700000000000000002";
const setup = { ops: { control: CTRL, log: OPS }, controlChannels: [CTRL] };

/** Fake channel (record sends) and message. */
function chan(id: string, o: { thread?: boolean; parentId?: string; overwrites?: any } = {}) {
  const sent: any[] = [];
  return {
    id,
    sent,
    parentId: o.parentId ?? null,
    ownerId: BOT,
    permissionOverwrites: o.overwrites,
    isThread: () => !!o.thread,
    isSendable: () => true,
    send: async (x: any) => void sent.push(x),
    sendTyping: async () => {},
  } as any;
}
function msg(channel: any, content: string) {
  const replies: any[] = [];
  const threads: any[] = [];
  const m: any = {
    author: { id: OWNER, bot: false },
    content,
    channel,
    guildId: "G1",
    guild: { id: "G1" },
    inGuild: () => true,
    mentions: { has: () => true },
    reply: async (x: any) => void replies.push(x),
    startThread: async (x: any) => {
      threads.push(x);
      return chan("thr", { thread: true });
    },
  };
  return { m, replies, threads };
}

function handler() {
  const asked: InlineRequest[] = [];
  const messages: any[] = [];
  const inline = async (r: InlineRequest) => {
    asked.push(r);
    return /^\/find/.test(r.text) ? "found" : null;
  };
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    guildId: "G1",
    setup,
    inline,
    handleMessage: async (message) => {
      messages.push(message);
      return "answer";
    },
  });
  return { onMessage, asked, messages };
}

test("command in a channel: inline reply, no thread, no task", async () => {
  const { onMessage, asked, messages } = handler();
  const c = chan("500000000000000001");
  const x = msg(c, `<@${BOT}> /find use bun`);
  await onMessage(x.m);
  expect(x.threads).toEqual([]);
  expect(messages).toEqual([]);
  expect(c.sent[0].content).toBe("found");
  expect(asked[0]).toMatchObject({ channelId: "500000000000000001", text: "/find use bun" });
});

test("command in a thread: replies in the thread, channelId is the parent", async () => {
  const { onMessage, asked, messages } = handler();
  const t = chan("thr9", { thread: true, parentId: "500000000000000001" });
  await onMessage(msg(t, "/find x y z").m);
  expect(messages).toEqual([]);
  expect(t.sent[0].content).toBe("found");
  expect(asked[0]).toMatchObject({ channelId: "500000000000000001" });
});

test("non-command still goes to the task layer", async () => {
  const { onMessage, messages } = handler();
  const t = chan("thr9", { thread: true, parentId: "500000000000000001" });
  await onMessage(msg(t, "what is this").m);
  expect(messages).toHaveLength(1);
});

test("command in a non-control ops channel is ignored (no runner call, no task)", async () => {
  const { onMessage, asked, messages } = handler();
  const c = chan(OPS);
  await onMessage(msg(c, "/find abc").m);
  expect(messages).toEqual([]);
  expect(asked).toEqual([]);
  expect(c.sent).toEqual([]);
});

test("control channel: the admin handler runs inline commands behind its gate", async () => {
  const ids = { guildId: "G1", ownerId: OWNER, botId: BOT };
  const asked: InlineRequest[] = [];
  const admin = createAdminHandler({
    home: "/nonexistent",
    guildId: "G1",
    ownerId: OWNER,
    botId: () => BOT,
    setup,
    inline: async (r) => {
      asked.push(r);
      return /^\/find/.test(r.text) ? "stored" : null;
    },
  });
  const overwrites = (list: any[]) => ({
    cache: new Map(
      list.map((o) => [
        o.id,
        { id: o.id, type: o.type, allow: { bitfield: o.allow }, deny: { bitfield: o.deny } },
      ]),
    ),
  });
  const priv = chan(CTRL, { overwrites: overwrites(privateOverwrites(ids)) });
  const ok = msg(priv, "/find ok ok");
  await admin(ok.m, "/find ok ok");
  expect(ok.replies[0].content).toBe("stored");
  expect(asked[0]).toMatchObject({ channelId: CTRL, text: "/find ok ok" });
  // not private -> refused before the runner
  asked.length = 0;
  const open = chan(CTRL, {
    overwrites: overwrites([{ id: "G1", type: OverwriteType.Role, allow: 0n, deny: 0n }]),
  });
  const bad = msg(open, "/find ok ok");
  await admin(bad.m, "/find ok ok");
  expect(asked).toEqual([]);
  expect(bad.replies[0].content).toContain("not private");
});
