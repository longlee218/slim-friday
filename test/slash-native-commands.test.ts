import { expect, test } from "bun:test";
import { SLASH_NAMES, slashToLegacy } from "../src/commands/slash-commands";
import { SLASH_DEFINITIONS, slashPayload, slashText } from "../src/commands/slash-definitions";
import { createMessageHandler, type InboundMessage } from "../src/ingress/discord-message-handler";
import { createSlashHandler, registerSlashCommands } from "../src/ingress/slash-interaction";

const OWNER = "111";
const BOT = "999";

test("definitions and the SLASH parser list the same commands", () => {
  expect(Object.keys(SLASH_DEFINITIONS).sort()).toEqual([...SLASH_NAMES].sort());
  expect(
    slashPayload()
      .map((c) => c.name)
      .sort(),
  ).toEqual([...SLASH_NAMES].sort());
  // The parser really knows each name (a slash text becomes a legacy text) and nothing else.
  for (const n of SLASH_NAMES) expect(slashToLegacy(`/${n}`)).not.toBe(`/${n}`);
  expect(slashToLegacy("/bogus")).toBe("/bogus");
});

test("slashText builds the typed text per command", () => {
  const v = (m: Record<string, string | boolean>) => (a: string) => m[a] ?? null;
  expect(slashText("stop", v({}))).toBe("/stop");
  expect(slashText("go", v({}))).toBe("/go");
  expect(slashText("go", v({ usd: "5" }))).toBe("/go +5");
  expect(slashText("go", v({ usd: "+2.5" }))).toBe("/go +2.5");
  expect(slashText("remember", v({ text: "tabs" }))).toBe("/remember tabs");
  expect(slashText("compact", v({ "dry-run": true }))).toBe("/compact dry-run");
  expect(slashText("compact", v({ "dry-run": false }))).toBe("/compact");
  expect(slashText("init-workspace", v({ name: "acme" }))).toBe("/init-workspace acme");
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

function setup(memory?: any) {
  const messages: InboundMessage[] = [];
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    guildId: "G1",
    handleMessage: async (message) => {
      messages.push(message);
      return "ok";
    },
    memory,
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

test("owner /go 5 keeps the +usd form", async () => {
  const { messages, handle } = setup();
  await handle(fakeInteraction("go", OWNER, { usd: "5" }).i);
  expect(messages[0]?.text).toBe("/go +5");
});

test("non-owner gets an ephemeral refusal and nothing runs", async () => {
  const { messages, handle } = setup();
  const { i, log } = fakeInteraction("stop", "222");
  await handle(i);
  expect(messages).toEqual([]);
  expect(log[0]).toStartWith("reply:Not allowed.");
});

test("memory command is answered inline, not run as a task", async () => {
  const { messages, handle } = setup(async (r: any) =>
    r.text.startsWith("/forget") ? "saved" : null,
  );
  const { i, sent } = fakeInteraction("forget", OWNER, { text: "tabs" });
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
  expect(log.at(-1)).toStartWith("edit:Mình chưa hoàn tất");
});
