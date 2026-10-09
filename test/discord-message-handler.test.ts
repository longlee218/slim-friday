import { expect, test } from "bun:test";
import { CLIENT_OPTIONS } from "../src/ingress/discord-bot";
import type { Task } from "../src/ingress/discord-message-handler";
import { createMessageHandler } from "../src/ingress/discord-message-handler";
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
  const tasks: Task[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    guildId,
    handleTask: async (t) => {
      tasks.push(t);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return { onMessage, tasks };
}

test("owner mention in channel -> thread created, task run, reply sent in thread without pings", async () => {
  const { onMessage, tasks } = setup("hi @everyone");
  const m = fakeMsg({});
  await onMessage(m.msg);
  expect(m.calls.threads).toEqual([{ name: "hello" }]);
  expect(tasks).toMatchObject([
    { source: "discord", userId: OWNER, threadId: "thr1", channelId: "chan", text: "hello" },
  ]);
  expect(tasks[0]!.notify).toBeFunction(); // lets the handoff post into the thread mid-run
  expect(m.thread.sent[0].content).toBe("hi @everyone");
  expect(m.thread.sent[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
});

test("non-owner and bot messages never reach the agent", async () => {
  const { onMessage, tasks } = setup();
  await onMessage(fakeMsg({ authorId: "222" }).msg);
  await onMessage(fakeMsg({ bot: true }).msg);
  const th = fakeChannel("thr9", { thread: true, ownerId: BOT });
  await onMessage(fakeMsg({ authorId: "222", channel: th, mention: false, content: "hey" }).msg);
  expect(tasks).toEqual([]);
});

test("message in a bot thread continues with the thread id, no mention needed", async () => {
  const { onMessage, tasks } = setup();
  const th = fakeChannel("thr7", { thread: true, ownerId: BOT, parentId: "parent9" });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "follow up" }).msg);
  // The routing key of a thread is its parent channel, never the thread id.
  expect(tasks[0]).toMatchObject({ threadId: "thr7", channelId: "parent9", text: "follow up" });
  expect(th.sent[0].content).toBe("answer");
});

test("thread owned by someone else is not a bot thread (needs mention)", async () => {
  const { onMessage, tasks } = setup();
  const th = fakeChannel("thrX", { thread: true, ownerId: "555" });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "hey" }).msg);
  expect(tasks).toEqual([]);
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
  const { onMessage, tasks } = setup();
  const m = fakeMsg({ content: `<@${BOT}> stop` });
  await onMessage(m.msg);
  expect(m.calls.threads).toEqual([]);
  expect(tasks).toEqual([]);
  expect(m.calls.reply[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
});

test("H1: client default allowedMentions disables all pings", () => {
  expect(CLIENT_OPTIONS.allowedMentions).toEqual({ parse: [], repliedUser: false });
});

test("pinned guild: a message from another guild is ignored, the pinned guild runs", async () => {
  const { onMessage, tasks } = setup("answer", "G1");
  await onMessage(fakeMsg({ guildId: "G2" }).msg);
  const th = fakeChannel("thr8", { thread: true, ownerId: BOT, parentId: "p" });
  await onMessage(fakeMsg({ guildId: "G2", channel: th, mention: false, content: "x" }).msg);
  expect(tasks).toEqual([]);
  await onMessage(fakeMsg({ guildId: "G1" }).msg);
  expect(tasks).toHaveLength(1);
});

test("thread message with a null parent channel is dropped and logged (no_parent_channel)", async () => {
  const { onMessage, tasks } = setup();
  const cap = captureLogs();
  const th = fakeChannel("thr5", { thread: true, ownerId: BOT }); // parentId null
  await onMessage(fakeMsg({ channel: th, mention: false, content: "x" }).msg);
  cap.stop();
  expect(tasks).toEqual([]);
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
  const tasks: Task[] = [];
  const admin: { prompt: string; channelId: string }[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    guildId: "G1",
    setup: setupWithOps,
    handleTask: async (t) => {
      tasks.push(t);
      return "answer";
    },
    admin: async (m, prompt) => void admin.push({ prompt, channelId: m.channel.id }),
  });
  return { onMessage, tasks, admin };
}

test("messages in ops channels or their threads never reach handleTask", async () => {
  const { onMessage, tasks, admin } = setupOps();
  const logs = captureLogs();
  await onMessage(fakeMsg({ channel: fakeChannel(OPS) }).msg); // mention in #ops-log
  const th = fakeChannel("thrO", { thread: true, ownerId: BOT, parentId: OPS });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "follow up" }).msg);
  const cth = fakeChannel("thrC", { thread: true, ownerId: BOT, parentId: CTRL });
  await onMessage(fakeMsg({ channel: cth, mention: false, content: "follow up" }).msg);
  logs.stop();
  expect(tasks).toEqual([]);
  expect(admin).toEqual([]);
  expect(logs.lines.filter((l) => l.reason === "ops_channel")).toHaveLength(3);
});

test("control channel text goes to admin handling only, no mention needed, no task", async () => {
  const { onMessage, tasks, admin } = setupOps();
  await onMessage(
    fakeMsg({ channel: fakeChannel(CTRL), mention: false, content: "init:workspace:x" }).msg,
  );
  expect(tasks).toEqual([]);
  expect(admin).toEqual([{ prompt: "init:workspace:x", channelId: CTRL }]);
});

test("admin text in a normal channel or thread is routed to the admin gate, not the agent", async () => {
  const { onMessage, tasks, admin } = setupOps();
  await onMessage(fakeMsg({ content: `<@${BOT}> init:workspace:x` }).msg);
  const th = fakeChannel("thr7", { thread: true, ownerId: BOT, parentId: "parent9" });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "init:workspace:y" }).msg);
  expect(tasks).toEqual([]);
  expect(admin.map((a) => a.prompt)).toEqual(["init:workspace:x", "init:workspace:y"]);
});

test("an admin hook that throws is contained", async () => {
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    setup: setupWithOps,
    handleTask: async () => "x",
    admin: async () => {
      throw new Error("boom");
    },
  });
  await onMessage(fakeMsg({ channel: fakeChannel(CTRL), mention: false, content: "help" }).msg);
});
