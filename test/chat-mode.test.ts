import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadsPort } from "../src/ingress/threads-port";
import { MEMORY_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { DIGEST_HEADING } from "../src/memory/channel-digest";
import { journalFile } from "../src/memory/daily-journal";
import { localDay } from "../src/memory/memory-clock";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import {
  createMessageHandler,
  type InboundMessage,
} from "../src/providers/discord/ingress/discord-message-handler";
import {
  type MessageFacts,
  routeMessage,
} from "../src/providers/discord/ingress/discord-message-rules";
import { threadFacts } from "../src/providers/discord/ingress/thread-placement";
import {
  CHAT_TOPIC,
  syncChannelTopics,
  TASK_TOPIC,
} from "../src/providers/discord/setup/channel-topic";
import { FLUSH_SYSTEM } from "../src/roles/prompts/memory-prompts";
import { titlePortFor } from "../src/roles/prompts/thread-title-note";
import { getSession } from "../src/storage/session-store";
import { getThreadSummary } from "../src/storage/thread-summary-store";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";
import { until } from "./teammate-harness";

const OWNER = "111";
const BOT = "999";
const CHAT = "chat1";
const TASK = "task1";

const facts = (over: Partial<MessageFacts> = {}): MessageFacts => ({
  authorId: OWNER,
  authorIsBot: false,
  inGuild: true,
  otherGuild: false,
  inBotThread: false,
  mentionsBot: false,
  content: "hello",
  ...over,
});

test("rules: a chat channel routes the owner inline with no mention; not a stranger; not without the fact", () => {
  expect(routeMessage(facts({ chatChannel: true }), OWNER, BOT)).toEqual({
    kind: "thread",
    prompt: "hello",
  });
  expect(routeMessage(facts({ chatChannel: true, authorId: "x" }), OWNER, BOT)).toEqual({
    kind: "ignore",
    reason: "not_owner",
  });
  expect(routeMessage(facts(), OWNER, BOT)).toEqual({ kind: "ignore", reason: "not_mentioned" });
  expect(routeMessage(facts({ mentionsBot: true }), OWNER, BOT).kind).toBe("channel");
  // the mention is stripped inline too
  expect(routeMessage(facts({ chatChannel: true, content: `<@${BOT}> hi` }), OWNER, BOT)).toEqual({
    kind: "thread",
    prompt: "hi",
  });
});

/** Fake channel; threads carry an owner and a parent. */
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

function msg(channel: any, text: string, o: { author?: string; mention?: boolean } = {}) {
  const started: any[] = [];
  const reply = async (x: any) => void channel.sent.push(x);
  const m: any = {
    id: "m1",
    author: { id: o.author ?? OWNER, bot: false },
    content: text,
    channel,
    guildId: "G",
    inGuild: () => true,
    mentions: { has: () => o.mention ?? false },
    react: async () => {},
    reply,
    startThread: async (x: any) => void started.push(x),
  };
  return { m, started };
}

function setup() {
  const messages: InboundMessage[] = [];
  const looked: string[] = [];
  const adopted = new Set<string>();
  const threads: ThreadsPort = {
    isAdopted: (id) => adopted.has(id),
    adopt: (id) => void adopted.add(id),
    recordBotThread: () => {},
    channelInfo: (c) => {
      looked.push(c);
      return c === CHAT
        ? { workspace: "main", mode: "chat" }
        : c === TASK
          ? { workspace: "main", mode: "task" }
          : undefined;
    },
  };
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    handleMessage: async (m) => {
      messages.push(m);
      return "answer";
    },
    setup: { controlChannels: [], ops: { log: "ops1" } } as any,
    threads,
  });
  return { onMessage, messages, looked, adopted };
}

test("handler: two owner messages without mention in a chat channel get two inline replies keyed by the channel id", async () => {
  const { onMessage, messages } = setup();
  const ch = chan(CHAT);
  const a = msg(ch, "first");
  await onMessage(a.m);
  await onMessage(msg(ch, "second").m);
  expect(a.started).toEqual([]); // no thread
  expect(messages.map((m) => [m.threadId, m.channelId, m.text])).toEqual([
    [CHAT, CHAT, "first"],
    [CHAT, CHAT, "second"],
  ]);
  expect(ch.sent.map((s: any) => s.content)).toEqual(["answer", "answer"]);
});

test("handler: /stop and /status run inline in a chat channel (no 'inside the thread' note)", async () => {
  const { onMessage, messages } = setup();
  const ch = chan(CHAT);
  await onMessage(msg(ch, "/stop").m);
  await onMessage(msg(ch, "/status").m);
  expect(messages.map((m) => m.text)).toEqual(["/stop", "/status"]);
  expect(ch.sent.map((s: any) => s.content)).toEqual(["answer", "answer"]);
});

test("handler: a stranger in a chat channel is ignored and never loads the workspaces", async () => {
  const { onMessage, messages, looked } = setup();
  const ch = chan(CHAT);
  await onMessage(msg(ch, "hi", { author: "stranger" }).m);
  expect(messages).toEqual([]);
  expect(looked).toEqual([]);
  expect(ch.sent).toEqual([]);
});

test("handler: a task channel is unchanged (no mention = ignored; mention = new thread)", async () => {
  const { onMessage, messages } = setup();
  const ch = chan(TASK);
  await onMessage(msg(ch, "no mention").m);
  expect(messages).toEqual([]);
  const x = msg(ch, `<@${BOT}> go`, { mention: true });
  x.m.startThread = async () => chan("newthr", { thread: true, ownerId: BOT, parentId: TASK });
  await onMessage(x.m);
  expect(messages[0]).toMatchObject({ threadId: "newthr", channelId: TASK });
});

test("handler: threads under a chat channel stay task threads (bot thread, adoption by mention)", async () => {
  const { onMessage, messages, adopted } = setup();
  const bot = chan("bt1", { thread: true, ownerId: BOT, parentId: CHAT });
  await onMessage(msg(bot, "in bot thread").m);
  const own = chan("ot1", { thread: true, ownerId: OWNER, parentId: CHAT });
  await onMessage(msg(own, "no mention").m); // owner-made, not adopted yet: ignored
  await onMessage(msg(own, `<@${BOT}> adopt me`, { mention: true }).m);
  expect(adopted.has("ot1")).toBe(true);
  expect(messages.map((m) => [m.threadId, m.channelId])).toEqual([
    ["bt1", CHAT],
    ["ot1", CHAT],
  ]);
});

test("titlePortFor: no rename port when threadId === channelId", () => {
  const port = { rename: async () => "renamed" as const };
  expect(titlePortFor({ threadId: CHAT, channelId: CHAT }, port)).toBeUndefined();
  expect(titlePortFor({ threadId: "t", channelId: CHAT }, port)).toBe(port);
});

/**
 * Real turn handler over a fake `query`; the test channel is a chat channel of `main` and the teammate (the foreground role)
 * answers inline through `notify`.
 */
/** `script` runs inside each fake model call (the teammate run and the flush one-shot alike) and may return the reply text. */
function turnHarness(script?: (options: any) => Promise<string | undefined>) {
  const env = makeEnv();
  const ws = env.paths.workspace("main");
  const doc = Bun.YAML.parse(readFileSync(ws.config, "utf8")) as object;
  writeFileSync(
    ws.config,
    Bun.YAML.stringify({ ...doc, channels: [{ id: TEST_CHANNEL, name: "chat", mode: "chat" }] }),
  );
  const calls: { prompt: string; resume?: string; options: any }[] = [];
  const posts: string[] = [];
  const queryFn = ((a: any) => {
    calls.push({ prompt: String(a.prompt), resume: a.options.resume, options: a.options });
    return (async function* () {
      const text = await script?.(a.options);
      yield resultMsg({
        session_id: "sess-chat",
        result: text ?? "answer",
        modelUsage: { "claude-sonnet-x": { contextWindow: 200_000 } },
      });
    })();
  }) as never;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn,
    teammateTiming: { debounceMs: 10, announceWindowMs: 20 },
    threadTitle: { rename: async () => "renamed" as const },
  });
  /** Send one owner message and wait for the teammate's posted reply. */
  const send = async (text: string) => {
    const n = posts.length;
    await handle({
      source: "t",
      userId: "u",
      threadId: TEST_CHANNEL,
      channelId: TEST_CHANNEL,
      text,
      notify: async (m: string) => void posts.push(m),
    });
    await until(() => posts.length > n);
  };
  return { env, calls, send, handle };
}

/** Names of the tools of the run's in-process memory server. */
const memoryTools = (options: any): string[] =>
  Object.keys(options.mcpServers?.[MEMORY_MCP_SERVER]?.instance?._registeredTools ?? {});

test("turns: the second chat message resumes the first session (sessions.thread_id = channel id); no set_title, no digest", async () => {
  const { env, calls, send } = turnHarness();
  await send("hello");
  await send("and again");
  expect(calls[0]?.resume).toBeUndefined();
  expect(calls[1]?.resume).toBe("sess-chat");
  expect(getSession(env.db, TEST_CHANNEL)?.session_id).toBe("sess-chat");
  expect(calls[0]?.prompt).toEndWith("<owner_message>\nhello\n</owner_message>");
  expect(calls[0]?.prompt).not.toContain(DIGEST_HEADING); // no channel digest in a chat channel
  const tools = memoryTools(calls[0]?.options);
  expect(tools).toContain("MemorySave"); // the probe sees the memory server's tools
  expect(tools).not.toContain("Orchestrate");
});

test("a compaction in a chat channel flushes into the channel journal, keyed by the channel id", async () => {
  const flushJson = '{"items":[{"kind":"decision","text":"Chat decisions go to the journal."}]}';
  const { env, calls, send, handle } = turnHarness(async (options) => {
    if (options.systemPrompt === FLUSH_SYSTEM) return flushJson; // the flush one-shot
    // The teammate run compacts: fire the SDK hooks the run registered, like the real SDK does.
    const sig = { signal: new AbortController().signal };
    const transcript = join(env.home, "t.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "We decided to keep chat notes." } })}\n`,
    );
    const pre = { hook_event_name: "PreCompact", trigger: "auto", transcript_path: transcript };
    await options.hooks.PreCompact[0].hooks[0](pre, undefined, sig);
    const post = { hook_event_name: "PostCompact", trigger: "auto", compact_summary: "A summary." };
    await options.hooks.PostCompact[0].hooks[0](post, undefined, sig);
    return undefined;
  });
  await send("hello");
  await handle.memoryJobs.drain(5000);
  expect(calls.some((c) => c.options.systemPrompt === FLUSH_SYSTEM)).toBe(true);
  expect(getThreadSummary(env.db, TEST_CHANNEL)?.summary).toBe("A summary.");
  const row = getThreadSummary(env.db, TEST_CHANNEL);
  expect(row?.flushed_cycle).toBe(row?.cycle ?? -1);
  const journal = journalFile(env.home, "main", "chat", localDay());
  expect(readFileSync(journal, "utf8")).toContain("- Chat decisions go to the journal.");
});

test("syncChannelTopics: sets only a differing topic, a failure is a warning that never throws", async () => {
  const env = makeEnv();
  const ws = env.paths.workspace("main");
  const doc = Bun.YAML.parse(readFileSync(ws.config, "utf8")) as object;
  const [A, B, C] = ["100000000000000011", "100000000000000012", "100000000000000013"];
  writeFileSync(
    ws.config,
    Bun.YAML.stringify({
      ...doc,
      channels: [
        { id: A, name: "a", mode: "chat" }, // wrong topic: set
        { id: B, name: "b", mode: "task", locations: [] }, // right topic: skipped
        { id: C, name: "c", mode: "chat" }, // edit fails: warned
      ],
    }),
  );
  const set: string[][] = [];
  const topics: Record<string, string> = { [A]: TASK_TOPIC, [B]: TASK_TOPIC, [C]: TASK_TOPIC };
  const client = {
    channels: {
      fetch: async (id: string) => ({
        topic: topics[id],
        setTopic: async (t: string) => {
          if (id === C) throw new Error("Missing Permissions");
          set.push([id, t]);
        },
      }),
    },
  } as any;
  expect(await syncChannelTopics(client, env.home)).toEqual([A]);
  expect(set).toEqual([[A, CHAT_TOPIC]]);
});

test("syncChannelTopics: owner-custom topic kept, empty set, other-mode bot topic replaced, skipped ids untouched", async () => {
  const env = makeEnv();
  const ws = env.paths.workspace("main");
  const doc = Bun.YAML.parse(readFileSync(ws.config, "utf8")) as object;
  const [A, B, C, D] = [
    "100000000000000021",
    "100000000000000022",
    "100000000000000023",
    "100000000000000024",
  ];
  writeFileSync(
    ws.config,
    Bun.YAML.stringify({
      ...doc,
      channels: [
        { id: A, name: "a", mode: "chat" }, // owner topic: kept
        { id: B, name: "b", mode: "chat" }, // empty: set
        { id: C, name: "c", mode: "chat" }, // old task topic: replaced
        { id: D, name: "d", mode: "chat" }, // skipped (ops)
      ],
    }),
  );
  const set: string[] = [];
  const topics: Record<string, string> = { [A]: "my notes", [B]: "", [C]: TASK_TOPIC, [D]: "" };
  const client = {
    channels: {
      fetch: async (id: string) => ({
        topic: topics[id],
        setTopic: async () => void set.push(id),
      }),
    },
  } as any;
  expect(await syncChannelTopics(client, env.home, new Set([D]))).toEqual([B, C]);
  expect(set).toEqual([B, C]);
});

test("threadFacts: a DM never looks the channel up for the chat check", () => {
  let lookups = 0;
  const threads = {
    channelInfo: () => (lookups++, { workspace: "w", mode: "chat" as const }),
  } as any;
  const ch = { id: "dm1", isThread: () => false };
  const msg = { author: { id: OWNER }, content: "hi" };
  expect(threadFacts(ch, BOT, new Set(), threads, msg, OWNER, false).chatChannel).toBe(false);
  expect(lookups).toBe(0);
  expect(threadFacts(ch, BOT, new Set(), threads, msg, OWNER, true).chatChannel).toBe(true);
});
