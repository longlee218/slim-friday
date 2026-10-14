import { expect, test } from "bun:test";
import { CLIENT_OPTIONS } from "../src/ingress/discord-bot";
import type { InboundMessage } from "../src/ingress/discord-message-handler";
import { createMessageHandler } from "../src/ingress/discord-message-handler";
import { BUSY_ACK_EMOJI } from "../src/ingress/discord-send";
import { captureLogs } from "../src/observability/logger";

const OWNER = "111";
const BOT = "999";

/** Fake sendable channel recording sends. */
function fakeChannel(
  id: string,
  opts: { thread?: boolean; ownerId?: string; parentId?: string } = {},
) {
  const sent: any[] = [];
  const ch: any = {
    id,
    sent,
    isThread: () => !!opts.thread,
    ownerId: opts.ownerId,
    parentId: opts.parentId ?? null,
    isSendable: () => true,
    send: async (o: any) => {
      sent.push(o);
    },
    sendTyping: async () => {},
  };
  return ch;
}

/** Fake Message with the fields onMessage reads. */
function fakeMsg(over: {
  authorId?: string;
  bot?: boolean;
  content?: string;
  mention?: boolean;
  channel?: any;
  guildId?: string;
  startThread?: any;
}) {
  const channel = over.channel ?? fakeChannel("chan");
  const calls: { reply: any[]; threads: any[] } = { reply: [], threads: [] };
  const thread = fakeChannel("thr1", { thread: true, ownerId: BOT });
  const msg: any = {
    author: { id: over.authorId ?? OWNER, bot: over.bot ?? false },
    content: over.content ?? `<@${BOT}> hello`,
    channel,
    guildId: over.guildId ?? "G1",
    inGuild: () => true,
    mentions: { has: () => over.mention ?? true },
    reply: async (o: any) => {
      calls.reply.push(o);
    },
    startThread:
      over.startThread ??
      (async (o: any) => {
        calls.threads.push(o);
        return thread;
      }),
  };
  return { msg, calls, thread, channel };
}

/** Handler with a recording fake task layer. */
function setup(reply: string | Error = "answer", guildId?: string) {
  const messages: InboundMessage[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    guildId,
    handleMessage: async (message) => {
      messages.push(message);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return { onMessage, messages };
}

test("owner mention in channel -> thread created, task run, reply sent in thread without pings", async () => {
  const { onMessage, messages } = setup("hi @everyone");
  const m = fakeMsg({});
  await onMessage(m.msg);
  expect(m.calls.threads).toEqual([{ name: expect.stringMatching(/^⏳ \d\d-\d\d \d\d:\d\d$/) }]); // never the first message
  expect(messages).toMatchObject([
    { source: "discord", userId: OWNER, threadId: "thr1", channelId: "chan", text: "hello" },
  ]);
  expect(messages[0]!.notify).toBeFunction(); // lets a dispatched plan post into the thread mid-run
  expect(m.thread.sent[0].content).toBe("hi @everyone");
  expect(m.thread.sent[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
});

test("non-owner and bot messages never reach the agent", async () => {
  const { onMessage, messages } = setup();
  await onMessage(fakeMsg({ authorId: "222" }).msg);
  await onMessage(fakeMsg({ bot: true }).msg);
  const th = fakeChannel("thr9", { thread: true, ownerId: BOT });
  await onMessage(fakeMsg({ authorId: "222", channel: th, mention: false, content: "hey" }).msg);
  expect(messages).toEqual([]);
});

test("message in a bot thread continues with the thread id, no mention needed", async () => {
  const { onMessage, messages } = setup();
  const th = fakeChannel("thr7", { thread: true, ownerId: BOT, parentId: "parent9" });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "follow up" }).msg);
  // The routing key of a thread is its parent channel, never the thread id.
  expect(messages[0]).toMatchObject({ threadId: "thr7", channelId: "parent9", text: "follow up" });
  expect(th.sent[0].content).toBe("answer");
});

test("thread owned by someone else is not a bot thread (needs mention)", async () => {
  const { onMessage, messages } = setup();
  const th = fakeChannel("thrX", { thread: true, ownerId: "555" });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "hey" }).msg);
  expect(messages).toEqual([]);
});

test("error after thread creation is reported inside the thread", async () => {
  const { onMessage } = setup(new Error("boom ghp_" + "a".repeat(36)));
  const m = fakeMsg({});
  await onMessage(m.msg);
  expect(m.thread.sent.at(-1).content).toContain("Something went wrong");
  expect(m.channel.sent).toEqual([]);
});

test("error before thread creation is reported in the channel", async () => {
  const { onMessage } = setup();
  const m = fakeMsg({
    startThread: async () => {
      throw new Error("no perms");
    },
  });
  await onMessage(m.msg);
  expect(m.channel.sent.at(-1).content).toContain("Something went wrong");
});

test("`@bot stop` in a channel gives a hint and starts no thread", async () => {
  const { onMessage, messages } = setup();
  const m = fakeMsg({ content: `<@${BOT}> stop` });
  await onMessage(m.msg);
  expect(m.calls.threads).toEqual([]);
  expect(messages).toEqual([]);
  expect(m.calls.reply[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
});

test("H1: client default allowedMentions disables all pings", () => {
  expect(CLIENT_OPTIONS.allowedMentions).toEqual({ parse: [], repliedUser: false });
});

test("pinned guild: a message from another guild is ignored, the pinned guild runs", async () => {
  const { onMessage, messages } = setup("answer", "G1");
  await onMessage(fakeMsg({ guildId: "G2" }).msg);
  const th = fakeChannel("thr8", { thread: true, ownerId: BOT, parentId: "p" });
  await onMessage(fakeMsg({ guildId: "G2", channel: th, mention: false, content: "x" }).msg);
  expect(messages).toEqual([]);
  await onMessage(fakeMsg({ guildId: "G1" }).msg);
  expect(messages).toHaveLength(1);
});

test("thread message with a null parent channel is dropped and logged (no_parent_channel)", async () => {
  const { onMessage, messages } = setup();
  const cap = captureLogs();
  const th = fakeChannel("thr5", { thread: true, ownerId: BOT }); // parentId null
  await onMessage(fakeMsg({ channel: th, mention: false, content: "x" }).msg);
  cap.stop();
  expect(messages).toEqual([]);
  expect(cap.lines.find((l) => l.reason === "no_parent_channel")).toMatchObject({
    event: "message.ignored",
    level: 40,
    threadId: "thr5",
  });
});

const OPS = "700000000000000001";
const CTRL = "700000000000000002";
const setupWithOps = {
  ops: { control: CTRL, log: OPS },
  controlChannels: [CTRL],
};

/** Handler with ops channels configured and a recording admin hook. */
function setupOps() {
  const messages: InboundMessage[] = [];
  const admin: { prompt: string; channelId: string }[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    guildId: "G1",
    setup: setupWithOps,
    handleMessage: async (message) => {
      messages.push(message);
      return "answer";
    },
    admin: async (m, prompt) => void admin.push({ prompt, channelId: m.channel.id }),
  });
  return { onMessage, messages, admin };
}

test("messages in ops channels or their threads never reach handleMessage", async () => {
  const { onMessage, messages, admin } = setupOps();
  const logs = captureLogs();
  await onMessage(fakeMsg({ channel: fakeChannel(OPS) }).msg); // mention in #ops-log
  const th = fakeChannel("thrO", { thread: true, ownerId: BOT, parentId: OPS });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "follow up" }).msg);
  const cth = fakeChannel("thrC", { thread: true, ownerId: BOT, parentId: CTRL });
  await onMessage(fakeMsg({ channel: cth, mention: false, content: "follow up" }).msg);
  logs.stop();
  expect(messages).toEqual([]);
  expect(admin).toEqual([]);
  expect(logs.lines.filter((l) => l.reason === "ops_channel")).toHaveLength(3);
});

test("control channel text goes to admin handling only, no mention needed, no task", async () => {
  const { onMessage, messages, admin } = setupOps();
  await onMessage(
    fakeMsg({ channel: fakeChannel(CTRL), mention: false, content: "init:workspace:x" }).msg,
  );
  expect(messages).toEqual([]);
  expect(admin).toEqual([{ prompt: "init:workspace:x", channelId: CTRL }]);
});

test("admin text in a normal channel or thread is routed to the admin gate, not the agent", async () => {
  const { onMessage, messages, admin } = setupOps();
  await onMessage(fakeMsg({ content: `<@${BOT}> init:workspace:x` }).msg);
  const th = fakeChannel("thr7", { thread: true, ownerId: BOT, parentId: "parent9" });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "init:workspace:y" }).msg);
  expect(messages).toEqual([]);
  expect(admin.map((a) => a.prompt)).toEqual(["init:workspace:x", "init:workspace:y"]);
});

test("an admin hook that throws is contained", async () => {
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    setup: setupWithOps,
    handleMessage: async () => "x",
    admin: async () => {
      throw new Error("boom");
    },
  });
  await onMessage(fakeMsg({ channel: fakeChannel(CTRL), mention: false, content: "help" }).msg);
});

test("a thread message carries an ack that reacts on the owner's message (M-d); a failing reaction is the caller's to catch", async () => {
  const { onMessage, messages } = setup();
  const th = fakeChannel("thr7", { thread: true, ownerId: BOT, parentId: "parent9" });
  const m = fakeMsg({ channel: th, mention: false, content: "follow up" });
  const reacted: string[] = [];
  m.msg.react = async (e: string) => void reacted.push(e);
  await onMessage(m.msg);
  await messages[0]!.ack?.();
  expect(reacted).toEqual([BUSY_ACK_EMOJI]);
  m.msg.react = async () => {
    throw new Error("Missing Permissions");
  };
  await expect(messages[0]!.ack?.()).rejects.toThrow("Missing Permissions");
});

test("messages of one thread reach the task layer in arrival order, even when the first one is slow to prepare (attachment download)", async () => {
  const { messages } = setup();
  const order: string[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    handleMessage: async (message) => {
      order.push(message.text.split("\n")[0]!);
      messages.push(message);
      return "ok";
    },
    // a slow download delays the first message's preparation
    attachments: {
      fetchFn: async () => {
        await Bun.sleep(80);
        return new Response("file body");
      },
    },
  });
  const th = fakeChannel("thr7", { thread: true, ownerId: BOT, parentId: "parent9" });
  const first = fakeMsg({ channel: th, mention: false, content: "first message" });
  (first.msg as any).attachments = new Map([
    [
      "1",
      {
        name: "n.txt",
        url: "https://cdn.discordapp.com/a/n.txt",
        size: 9,
        contentType: "text/plain",
      },
    ],
  ]);
  const second = fakeMsg({ channel: th, mention: false, content: "second message" });
  await Promise.all([onMessage(first.msg), onMessage(second.msg)]);
  expect(order).toEqual(["first message", "second message"]);
});
