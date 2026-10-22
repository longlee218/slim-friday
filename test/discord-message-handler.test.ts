import { expect, test } from "bun:test";
import { createMessageReceipt } from "../src/ingress/message-receipt";
import { captureLogs } from "../src/observability/logger";
import { CLIENT_OPTIONS } from "../src/providers/discord/ingress/discord-bot";
import type { InboundMessage } from "../src/providers/discord/ingress/discord-message-handler";
import { createMessageHandler } from "../src/providers/discord/ingress/discord-message-handler";
import { BUSY_ACK_EMOJI, sendReport } from "../src/providers/discord/ui/send/send-port";
import { TEST_CHANNEL } from "./helpers";
import { leadHarness, until } from "./lead-harness";

const OWNER = "111";
/** Receipt delay injected into the handler (the production default is 2 s). */
const RECEIPT_MS = 100;
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
  const calls = {
    reply: [] as any[],
    threads: [] as any[],
    reactions: [] as string[],
    removed: [] as string[],
  };
  const thread = fakeChannel("thr1", { thread: true, ownerId: BOT });
  const msg: any = {
    react: async (emoji: string) => {
      calls.reactions.push(emoji);
    },
    reactions: {
      cache: new Map([
        [
          BUSY_ACK_EMOJI,
          {
            users: {
              remove: async (id: string) => {
                calls.removed.push(id);
              },
            },
          },
        ],
      ]),
    },
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
    receiptDelayMs: RECEIPT_MS,
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

test("a run that returns nothing (its result was replaced) sends no reply", async () => {
  const messages: InboundMessage[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    receiptDelayMs: RECEIPT_MS,
    handleMessage: async (message) => {
      messages.push(message);
      return undefined;
    },
  });
  const th = fakeChannel("thr5", { thread: true, ownerId: BOT, parentId: "parent5" });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "old request" }).msg);
  expect(messages).toHaveLength(1);
  expect(th.sent).toEqual([]);
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
  const { onMessage } = setup(new Error(`boom ghp_${"a".repeat(36)}`));
  const m = fakeMsg({});
  await onMessage(m.msg);
  expect(m.thread.sent.at(-1).content).toContain("couldn't finish");
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
  expect(m.channel.sent.at(-1).content).toContain("couldn't finish");
});

test("`@bot /stop` in a channel gives a hint and starts no thread", async () => {
  const { onMessage, messages } = setup();
  const m = fakeMsg({ content: `<@${BOT}> /stop` });
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
    receiptDelayMs: RECEIPT_MS,
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
    fakeMsg({ channel: fakeChannel(CTRL), mention: false, content: "/init-workspace x" }).msg,
  );
  expect(messages).toEqual([]);
  expect(admin).toEqual([{ prompt: "/init-workspace x", channelId: CTRL }]);
});

test("admin text in a normal channel or thread is routed to the admin gate, not the agent", async () => {
  const { onMessage, messages, admin } = setupOps();
  await onMessage(fakeMsg({ content: `<@${BOT}> /init-workspace x` }).msg);
  const th = fakeChannel("thr7", { thread: true, ownerId: BOT, parentId: "parent9" });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "/init-workspace y" }).msg);
  expect(messages).toEqual([]);
  expect(admin.map((a) => a.prompt)).toEqual(["/init-workspace x", "/init-workspace y"]);
});

test("an admin hook that throws is contained", async () => {
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    receiptDelayMs: RECEIPT_MS,
    setup: setupWithOps,
    handleMessage: async () => "x",
    admin: async () => {
      throw new Error("boom");
    },
  });
  await onMessage(fakeMsg({ channel: fakeChannel(CTRL), mention: false, content: "help" }).msg);
});

test("messages of one thread reach the task layer in arrival order, even when the first one is slow to prepare (attachment download)", async () => {
  const { messages } = setup();
  const order: string[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    receiptDelayMs: RECEIPT_MS,
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

/** Hold a turn without relying on model timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("fast visible reply cancels the per-message receipt", async () => {
  const m = fakeMsg({});
  await setup().onMessage(m.msg);
  await Bun.sleep(RECEIPT_MS + 80);
  expect(m.calls.reactions).toEqual([]);
});

test("delayed replies get one receipt removed after sending, even when reaction operations fail", async () => {
  for (const failure of ["none", "react", "remove"]) {
    const gate = deferred<string>();
    const m = fakeMsg({});
    if (failure === "react")
      m.msg.react = async () => {
        throw new Error("reaction failed");
      };
    if (failure === "remove")
      m.msg.reactions.cache.get(BUSY_ACK_EMOJI).users.remove = async () => {
        throw new Error("removal failed");
      };
    const handler = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: () => gate.promise,
    });
    const pending = handler(m.msg);
    await Bun.sleep(RECEIPT_MS + 80);
    if (failure !== "react") expect(m.calls.reactions).toEqual([BUSY_ACK_EMOJI]);
    gate.resolve("finished");
    await pending;
    expect(m.thread.sent.at(-1).content).toBe("finished");
    if (failure === "none") expect(m.calls.removed).toEqual([BOT]);
  }
}, 10000);

test("notify stops receipt and typing refresh while the background turn continues", async () => {
  const gate = deferred<string>();
  const notified = deferred<void>();
  const m = fakeMsg({});
  let typing = 0;
  m.thread.sendTyping = async () => {
    typing++;
  };
  const handler = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    receiptDelayMs: RECEIPT_MS,
    handleMessage: async (message) => {
      await message.notify!("working");
      notified.resolve();
      return gate.promise;
    },
  });
  const pending = handler(m.msg);
  await notified.promise;
  await Bun.sleep(8100);
  expect(typing).toBe(1);
  expect(m.calls.reactions).toEqual([]);
  gate.resolve("done");
  await pending;
}, 12000);

test("ignored and control messages never get a receipt", async () => {
  const ignored = fakeMsg({ authorId: "other" });
  const control = fakeMsg({ channel: fakeChannel(CTRL), mention: false, content: "help" });
  const h = setupOps();
  await Promise.all([h.onMessage(ignored.msg), h.onMessage(control.msg)]);
  await Bun.sleep(RECEIPT_MS + 80);
  expect(ignored.calls.reactions).toEqual([]);
  expect(control.calls.reactions).toEqual([]);
});

test("both ordered messages get timely receipts while the first attachment is downloading", async () => {
  const gate = deferred<Response>();
  const order: string[] = [];
  const th = fakeChannel("ordered", { thread: true, ownerId: BOT, parentId: "parent" });
  const first = fakeMsg({ channel: th, mention: false, content: "first" });
  first.msg.attachments = new Map([
    [
      "a",
      {
        name: "n.txt",
        url: "https://cdn.discordapp.com/a/n.txt",
        size: 9,
        contentType: "text/plain",
      },
    ],
  ]);
  const second = fakeMsg({ channel: th, mention: false, content: "second" });
  const handler = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    receiptDelayMs: RECEIPT_MS,
    attachments: { fetchFn: () => gate.promise },
    handleMessage: async (message) => {
      order.push(message.text.split("\n")[0]!);
      return "ok";
    },
  });
  const pending = Promise.all([handler(first.msg), handler(second.msg)]);
  await Bun.sleep(RECEIPT_MS + 80);
  expect(first.calls.reactions).toEqual([BUSY_ACK_EMOJI]);
  expect(second.calls.reactions).toEqual([BUSY_ACK_EMOJI]);
  gate.resolve(new Response("body"));
  await pending;
  expect(order).toEqual(["first", "second"]);
  expect(first.calls.removed).toEqual([BOT]);
  expect(second.calls.removed).toEqual([BOT]);
});

test("receipt visibility waits for an in-flight reaction and removes it only once", async () => {
  const gate = deferred<void>();
  const events: string[] = [];
  const receipt = createMessageReceipt(
    async () => {
      events.push("react");
      await gate.promise;
    },
    async () => {
      events.push("remove");
    },
    1,
  );
  await Bun.sleep(10);
  const first = receipt.visible();
  const second = receipt.visible();
  expect(first).toBe(second);
  expect(events).toEqual(["react"]);
  gate.resolve();
  await first;
  expect(events).toEqual(["react", "remove"]);
  receipt.dispose();
});

test("failed visible sends leave the receipt present", async () => {
  const gate = deferred<string>();
  const m = fakeMsg({});
  m.thread.send = async () => {
    throw new Error("send failed");
  };
  const handler = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    receiptDelayMs: RECEIPT_MS,
    handleMessage: () => gate.promise,
  });
  const pending = handler(m.msg);
  await Bun.sleep(RECEIPT_MS + 80);
  gate.resolve("answer");
  await pending;
  expect(m.calls.reactions).toEqual([BUSY_ACK_EMOJI]);
  expect(m.calls.removed).toEqual([]);
});

test("a caught failed later notification stops typing during deferred background work", async () => {
  const gate = deferred<string>();
  const caught = deferred<void>();
  const m = fakeMsg({});
  let typing = 0;
  m.thread.sendTyping = async () => {
    typing++;
  };
  const send = m.thread.send;
  m.thread.send = async (output: any) => {
    if (output.content === "later") throw new Error("notification send failed");
    await send(output);
  };
  const handler = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    receiptDelayMs: RECEIPT_MS,
    handleMessage: async (message) => {
      await message.notify!("accepted");
      try {
        await message.notify!("later");
      } catch {
        caught.resolve();
      }
      return gate.promise;
    },
  });
  const pending = handler(m.msg);
  await caught.promise;
  const before = typing;
  await Bun.sleep(8100);
  const after = typing;
  gate.resolve("done");
  await pending;
  expect(before).toBe(2);
  expect(after).toBe(before);
  expect(m.thread.sent.map((output: any) => output.content)).toEqual(["accepted", "done"]);
}, 12000);

test("unknown ingress failure uses owner language and never leaks exception or guessed cause", async () => {
  const { onMessage } = setup(new Error("SECRET raw SDK exception"));
  const { msg, thread } = fakeMsg({ content: `<@${BOT}> giúp tôi đọc file này` });
  await onMessage(msg);
  const content = thread.sent.map((s: any) => s.content).join("\n");
  expect(content).toContain("chưa làm xong");
  expect(content).not.toMatch(/SECRET|SDK|logs|permission|quota/i);
});

const V2_FLAG = 1 << 15;

test("a long Markdown reply is a components-v2 message: summary, file component, attachment, no content/embeds", async () => {
  const mermaid = "```mermaid\ngraph TD; A-->B\n```";
  const key = `ghp_${"a".repeat(36)}`;
  const long = `${"line of text\n".repeat(600)}${mermaid}\n[Docs](https://d.example/x) [local](file:///tmp/x.md) ${key}`;
  const { onMessage } = setup(long);
  const m = fakeMsg({});
  await onMessage(m.msg);
  const sent = m.thread.sent[0];
  expect(sent.content).toBeUndefined();
  expect(sent.embeds).toBeUndefined();
  expect(sent.flags & V2_FLAG).toBe(V2_FLAG);
  expect(sent.allowedMentions).toEqual({ parse: [], repliedUser: false });
  const json = sent.components.map((c: any) => c.toJSON());
  expect(json.map((c: any) => c.type)).toEqual([10, 13, 1]);
  expect(json[1].file.url).toBe("attachment://reply.md");
  expect(json[2].components.map((b: any) => b.url)).toEqual(["https://d.example/x"]);
  const file = sent.files[0].attachment.toString();
  expect(file).toContain("graph TD; A-->B"); // Mermaid source kept verbatim
  expect(file).not.toContain(key);
});

test("a short Markdown reply stays one plain inline message", async () => {
  const { onMessage } = setup("**bold** [Docs](https://d.example)");
  const m = fakeMsg({});
  await onMessage(m.msg);
  expect(m.thread.sent[0].content).toBe("**bold** [Docs](https://d.example)");
  expect(m.thread.sent[0].flags).toBeUndefined();
});

test("a failed report send leaves the receipt present (visible never fires)", async () => {
  const gate = deferred<string>();
  const m = fakeMsg({});
  m.thread.send = async () => {
    throw new Error("send failed");
  };
  const handler = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    receiptDelayMs: RECEIPT_MS,
    handleMessage: () => gate.promise,
  });
  const pending = handler(m.msg);
  await Bun.sleep(RECEIPT_MS + 80);
  gate.resolve("long line\n".repeat(700));
  await pending;
  expect(m.calls.removed).toEqual([]);
});

test("sendReport: structured links, over-long url dropped, report still sent; summary-only has no file", async () => {
  const ch = fakeChannel("c");
  await sendReport(ch, {
    summary: "done",
    links: [
      { label: "PR", url: "https://pr.example/1" },
      { label: "big", url: `https://big.example/${"y".repeat(600)}` },
      { label: "local", url: "/tmp/x.md" },
    ],
  });
  const sent = ch.sent[0];
  expect(sent.files).toEqual([]);
  expect(sent.content).toBeUndefined();
  const json = sent.components.map((c: any) => c.toJSON());
  expect(json.map((c: any) => c.type)).toEqual([10, 1]);
  expect(json[1].components.map((b: any) => b.url)).toEqual(["https://pr.example/1"]);
});

test("lead level: a stranger's or a bot's message never reaches the lead queue; the owner's does", async () => {
  const h = leadHarness(async () => "lead answer");
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    receiptDelayMs: RECEIPT_MS,
    handleMessage: h.handle,
  });
  const th = fakeChannel("thrL", { thread: true, ownerId: BOT, parentId: TEST_CHANNEL });
  await onMessage(fakeMsg({ authorId: "222", channel: th, mention: false, content: "hey" }).msg);
  await onMessage(fakeMsg({ bot: true, channel: th, mention: false, content: "hey" }).msg);
  await new Promise((r) => setTimeout(r, 100)); // past the lead queue's debounce
  expect(h.ofKind("lead")).toHaveLength(0);
  expect(h.env.db.query("SELECT COUNT(*) AS n FROM thread_events").get()).toEqual({ n: 0 });
  await onMessage(fakeMsg({ channel: th, mention: false, content: "hello" }).msg);
  await until(() => h.ofKind("lead").length === 1);
  await until(() => th.sent.some((s: any) => s.content === "lead answer")); // the lead posts through notify
});
