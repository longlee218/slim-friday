import { expect, test } from "bun:test";
import { createMessageHandler, type InboundMessage } from "../src/ingress/discord-message-handler";
import type { ThreadsPort } from "../src/ingress/thread-placement";
import { placeholderName } from "../src/ingress/thread-placement";
import { createThreadsPort } from "../src/ingress/threads-port";
import { openDb } from "../src/storage/db";
import { getThread } from "../src/storage/thread-store";

const OWNER = "111";
const BOT = "999";
const MAPPED = "mapped1";
const OPS = "opsch1";

/** Fake channel; `thread` channels carry an owner and a parent. */
function chan(id: string, o: { thread?: boolean; ownerId?: string; parentId?: string } = {}) {
  const sent: any[] = [];
  return {
    id,
    sent,
    isThread: () => !!o.thread,
    ownerId: o.ownerId,
    parentId: o.parentId ?? null,
    isSendable: () => true,
    send: async (x: any) => void sent.push(x),
    sendTyping: async () => {},
  } as any;
}

/** In-memory port: MAPPED is a mapped channel, everything else is not. */
function fakePort() {
  const adopted = new Set<string>();
  const rows: any[] = [];
  const port: ThreadsPort = {
    isAdopted: (id) => adopted.has(id),
    adopt: (id, c) => {
      adopted.add(id);
      rows.push({ adopt: id, c });
    },
    recordBotThread: (id, c, p) => void rows.push({ bot: id, c, p }),
    channelInfo: (c) => (c === MAPPED ? { workspace: "main", mode: "task" } : undefined),
  };
  return { port, adopted, rows };
}

function setup(port: ThreadsPort) {
  const messages: InboundMessage[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    handleMessage: async (m) => {
      messages.push(m);
      return "answer";
    },
    setup: { controlChannels: [], ops: { log: OPS } } as any,
    threads: port,
  });
  return { onMessage, messages };
}

/** Fake message; `startThread` calls are recorded. */
function msg(channel: any, o: { author?: string; mention?: boolean; text?: string } = {}) {
  const started: any[] = [];
  const thread = chan("newthr", { thread: true, ownerId: BOT, parentId: channel.id });
  const m: any = {
    id: "m1",
    author: { id: o.author ?? OWNER, bot: false },
    content: o.text ?? `<@${BOT}> question`,
    channel,
    guildId: "G",
    inGuild: () => true,
    mentions: { has: () => o.mention ?? true },
    react: async () => {},
    reply: async () => {},
    startThread: async (x: any) => {
      started.push(x);
      return thread;
    },
  };
  return { m, started, thread };
}

test("placeholderName is `⏳ MM-DD HH:MM` in local time", () => {
  expect(placeholderName(new Date(2026, 9, 14, 8, 5))).toBe("⏳ 10-14 08:05");
});

test("new conversation: thread gets the placeholder and a bot row", async () => {
  const { port, rows } = fakePort();
  const { onMessage, messages } = setup(port);
  const x = msg(chan(MAPPED));
  await onMessage(x.m);
  expect(x.started[0].name).toMatch(/^⏳ \d\d-\d\d \d\d:\d\d$/);
  expect(rows).toEqual([{ bot: "newthr", c: MAPPED, p: x.started[0].name }]);
  expect(messages[0]).toMatchObject({ threadId: "newthr", channelId: MAPPED });
});

test("with the real port the row carries the workspace-less placeholder row (unmapped parent)", async () => {
  const db = openDb(":memory:");
  const { onMessage } = setup(createThreadsPort(db, "/nonexistent-home"));
  const x = msg(chan("plain"));
  await onMessage(x.m);
  expect(getThread(db, "newthr")).toMatchObject({
    origin: "bot",
    channel_id: "plain",
    workspace: "",
  });
});

test("owner-made thread + mention: adopted, answered, never startThread; next message needs no mention", async () => {
  const { port, adopted } = fakePort();
  const { onMessage, messages } = setup(port);
  const th = chan("own1", { thread: true, ownerId: OWNER, parentId: MAPPED });
  const first = msg(th);
  await onMessage(first.m);
  expect(first.started).toEqual([]);
  expect(adopted.has("own1")).toBe(true);
  expect(messages[0]).toMatchObject({ threadId: "own1", channelId: MAPPED, text: "question" });
  expect(th.sent[0].content).toBe("answer");
  await onMessage(msg(th, { mention: false, text: "follow up" }).m);
  expect(messages[1]).toMatchObject({ threadId: "own1", text: "follow up" });
});

test("stranger in an owner-made thread is ignored, nothing adopted", async () => {
  const { port, adopted } = fakePort();
  const { onMessage, messages } = setup(port);
  const th = chan("own2", { thread: true, ownerId: OWNER, parentId: MAPPED });
  await onMessage(msg(th, { author: "222" }).m);
  expect(messages).toEqual([]);
  expect(adopted.size).toBe(0);
});

test("owner-made thread without a mention is ignored until adopted", async () => {
  const { port } = fakePort();
  const { onMessage, messages } = setup(port);
  const th = chan("own3", { thread: true, ownerId: OWNER, parentId: MAPPED });
  await onMessage(msg(th, { mention: false }).m);
  expect(messages).toEqual([]);
});

test("ops thread is never adopted", async () => {
  const { port, adopted } = fakePort();
  const { onMessage, messages } = setup(port);
  const th = chan("ops1", { thread: true, ownerId: OWNER, parentId: OPS });
  const x = msg(th);
  await onMessage(x.m);
  expect(messages).toEqual([]);
  expect(adopted.size).toBe(0);
  expect(x.started).toEqual([]);
});

test("thread under an unmapped parent is not adopted and never calls startThread in a thread", async () => {
  const { port, adopted } = fakePort();
  const { onMessage } = setup(port);
  const th = chan("own4", { thread: true, ownerId: OWNER, parentId: "unmapped" });
  await onMessage(msg(th).m);
  expect(adopted.size).toBe(0);
});

/** Port whose lookups are counted (and may throw). */
function countingPort(o: { throwIsAdopted?: boolean; throwAdopt?: boolean } = {}) {
  const calls = { isAdopted: 0, channelInfo: 0 };
  const port: ThreadsPort = {
    isAdopted: () => {
      calls.isAdopted++;
      if (o.throwIsAdopted) throw new Error("sqlite boom");
      return false;
    },
    adopt: () => {
      if (o.throwAdopt) throw new Error("write boom");
    },
    recordBotThread: () => {},
    channelInfo: () => {
      calls.channelInfo++;
      return { workspace: "main", mode: "task" };
    },
  };
  return { port, calls };
}

test("M1: a stranger or a no-mention message never triggers channelInfo (workspace load)", async () => {
  const { port, calls } = countingPort();
  const { onMessage } = setup(port);
  const th = chan("own5", { thread: true, ownerId: OWNER, parentId: MAPPED });
  await onMessage(msg(th, { author: "222" }).m);
  await onMessage(msg(th, { mention: false, text: "chat" }).m);
  expect(calls.channelInfo).toBe(0);
  expect(calls.isAdopted).toBe(2); // the cheap indexed check still runs
  await onMessage(msg(th).m); // owner + @mention: now it is looked up
  expect(calls.channelInfo).toBe(1);
});

test("M2: isAdopted throwing is logged; the thread counts as not adopted (no adoption turn), no rejection", async () => {
  const { port } = countingPort({ throwIsAdopted: true });
  const { onMessage, messages } = setup(port);
  const th = chan("own6", { thread: true, ownerId: OWNER, parentId: MAPPED });
  await onMessage(msg(th).m);
  expect(messages.every((m) => m.threadId !== "own6")).toBe(true);
});

test("M4: a failing adoption write is logged and the turn is still answered", async () => {
  const { port } = countingPort({ throwAdopt: true });
  const { onMessage, messages } = setup(port);
  const th = chan("own7", { thread: true, ownerId: OWNER, parentId: MAPPED });
  await onMessage(msg(th).m);
  expect(messages[0]).toMatchObject({ threadId: "own7" });
  expect(th.sent[0].content).toBe("answer");
});

test("slash command (mention implied, no <@bot> in text) does not adopt an owner-made thread", async () => {
  const { port, adopted } = fakePort();
  const { onMessage } = setup(port);
  const th = chan("own8", { thread: true, ownerId: OWNER, parentId: MAPPED });
  await onMessage(msg(th, { text: "/ask something" }).m);
  expect(adopted.size).toBe(0);
});

test("M2: a synchronous throw from admin is caught on the control path", async () => {
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    handleMessage: async () => "x",
    setup: { controlChannels: ["ctl"], ops: { log: OPS } } as any,
    admin: () => {
      throw new Error("sync boom");
    },
  });
  await onMessage(msg(chan("ctl"), { text: "init channel x" }).m);
});
