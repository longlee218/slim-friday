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
