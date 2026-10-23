import { expect, test } from "bun:test";
import { parseSlash, SLASH_NAMES } from "../src/commands/slash-commands";
import { SLASH_DEFINITIONS, slashPayload, slashText } from "../src/commands/slash-definitions";
import {
  createMessageHandler,
  type InboundMessage,
} from "../src/providers/discord/ingress/discord-message-handler";
import {
  createSlashHandler,
  registerSlashCommands,
} from "../src/providers/discord/ingress/slash-interaction";

const OWNER = "111";
const BOT = "999";

test("definitions and the SLASH parser list the same commands", () => {
  expect(Object.keys(SLASH_DEFINITIONS).sort()).toEqual([...SLASH_NAMES].sort());
  expect(
    slashPayload()
      .map((c) => c.name)
      .sort(),
  ).toEqual([...SLASH_NAMES].sort());
  // The parser really knows each name and nothing else.
  for (const n of SLASH_NAMES) expect(parseSlash(`/${n}`)?.name).toBe(n);
  expect(parseSlash("/bogus")).toBeNull();
});

test("slashText builds the typed text per command", () => {
  const v = (m: Record<string, string | boolean>) => (a: string) => m[a] ?? null;
  expect(slashText("stop", v({}))).toBe("/stop");
  expect(slashText("find", v({ keywords: "invoice" }))).toBe("/find invoice");
  expect(slashText("teammate", v({ command: "list" }))).toBe("/teammate list");
  expect(slashText("constructor", v({}))).toBeNull();
});

test("registration: guild when pinned, global otherwise, failure never throws", async () => {
  const calls: unknown[][] = [];
  const client: any = {
    application: { commands: { set: async (...a: unknown[]) => void calls.push(a) } },
  };
  await registerSlashCommands(client, "G1");
  await registerSlashCommands(client);
  expect(calls[0]?.[1]).toBe("G1");
  expect(calls[1]?.length).toBe(1);
  expect(((calls[0]?.[0] ?? []) as unknown[]).length).toBe(SLASH_NAMES.length);
  const bad: any = {
    application: { commands: { set: async () => Promise.reject(new Error("x")) } },
  };
  await registerSlashCommands(bad, "G1");
});

/** A fake chat-input interaction in a bot thread (or a plain channel). */
function fakeInteraction(
  name: string,
  userId: string,
  opts: Record<string, unknown> = {},
  thread = true,
) {
  const log: string[] = [];
  const sent: any[] = [];
  const channel: any = {
    id: "T1",
    isThread: () => thread,
    ownerId: BOT,
    parentId: "C1",
    isSendable: () => true,
    send: async (o: any) => void sent.push(o),
    sendTyping: async () => {},
  };
  const i: any = {
    id: "I1",
    commandName: name,
    user: { id: userId, bot: false },
    channel,
    channelId: "T1",
    guildId: "G1",
    guild: {},
    inGuild: () => true,
    isChatInputCommand: () => true,
    options: { get: (n: string) => (n in opts ? { value: opts[n] } : null) },
    reply: async (o: any) => void log.push(`reply:${o.content}:${o.flags}`),
    deferReply: async () => void log.push("defer"),
    editReply: async (o: any) => void log.push(`edit:${typeof o === "string" ? o : o.content}`),
    deleteReply: async () => void log.push("delete"),
  };
  return { i, log, sent };
}

function setup(inline?: any) {
  const messages: InboundMessage[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    guildId: "G1",
    handleMessage: async (message) => {
      messages.push(message);
      return "ok";
    },
    inline,
  });
  return { messages, handle: createSlashHandler({ ownerId: OWNER, onMessage }) };
}

test("owner /stop in a thread reaches the task handler as the slash text", async () => {
  const { messages, handle } = setup();
  const { i, log, sent } = fakeInteraction("stop", OWNER);
  await handle(i);
  expect(messages.map((message) => message.text)).toEqual(["/stop"]);
  expect(sent[0].content).toBe("ok");
  expect(log).toEqual(["defer", "delete"]);
});

test("non-owner gets an ephemeral refusal and nothing runs", async () => {
  const { messages, handle } = setup();
  const { i, log } = fakeInteraction("stop", "222");
  await handle(i);
  expect(messages).toEqual([]);
  // "stop" is neutral: the default conversation language (Vietnamese) applies.
  expect(log[0]).toStartWith("reply:Bạn không có quyền dùng lệnh này.");
});

test("inline command is answered inline, not run as a task", async () => {
  const { messages, handle } = setup(async (r: any) =>
    r.text.startsWith("/find") ? "saved" : null,
  );
  const { i, sent } = fakeInteraction("find", OWNER, { keywords: "tabs" });
  await handle(i);
  expect(messages).toEqual([]);
  expect(sent[0].content).toBe("saved");
});

test("a handler failure edits the placeholder and does not throw", async () => {
  const handle = createSlashHandler({
    ownerId: OWNER,
    onMessage: async () => Promise.reject(new Error("boom")),
  });
  const { i, log } = fakeInteraction("stop", OWNER);
  await handle(i);
  expect(log.at(-1)).toStartWith("edit:Mình chưa làm xong việc này");
});
