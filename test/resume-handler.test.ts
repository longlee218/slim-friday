import { expect, test } from "bun:test";
import type { InboundMessage } from "../src/ingress/discord-message-handler";
import { createResumeHandler } from "../src/lifecycle/resume-interrupted";
import { captureLogs } from "../src/observability/logger";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { makeEnv } from "./helpers";

const OWNER = "111";

/** Fake sendable channel; `parentId` set makes it a thread. */
const fakeChannel = (id: string, parentId?: string | null) =>
  ({
    id,
    isSendable: () => true,
    isThread: () => parentId !== undefined,
    parentId,
    send: async () => {},
    sendTyping: async () => {},
  }) as any;

/** Fake Resume button click in `channel` (customId names the thread). */
function click(channel: any, over: { guildId?: string; userId?: string } = {}) {
  const calls = { update: 0, reply: 0 };
  const i: any = {
    isButton: () => true,
    customId: `resume:${channel.id}:go`,
    user: { id: over.userId ?? OWNER },
    guildId: over.guildId ?? "G1",
    channelId: channel.id,
    channel,
    update: async () => void calls.update++,
    reply: async () => void calls.reply++,
  };
  return { i, calls };
}

/** Resume handler with a recording fake task layer. */
function setup(guildId?: string) {
  const messages: InboundMessage[] = [];
  const handle = createResumeHandler({
    db: makeEnv().db,
    getClient: () => undefined,
    ownerId: OWNER,
    guildId,
    handleMessage: async (message) => {
      messages.push(message);
      return "ok";
    },
  });
  return { handle, messages };
}

test("thread button: InboundMessage.channelId is the thread's parent channel", async () => {
  const { handle, messages } = setup();
  await handle(click(fakeChannel("thr1", "parent5")).i);
  expect(messages).toMatchObject([{ threadId: "thr1", channelId: "parent5" }]);
});

test("button outside a thread (no parent): nothing runs, no 'Resuming...' update", async () => {
  const { handle, messages } = setup();
  const c = click(fakeChannel("chan1"));
  c.i.channel.isThread = () => false;
  await handle(c.i);
  expect(messages).toEqual([]);
  expect(c.calls.update).toBe(0);
});

test("pinned guild: a button from another guild is ignored, the pinned guild runs", async () => {
  const { handle, messages } = setup("G1");
  const other = click(fakeChannel("thr1", "p"), { guildId: "G2" });
  const cap = captureLogs();
  await handle(other.i);
  cap.stop();
  expect(cap.lines.find((l) => l.event === "message.ignored")).toMatchObject({
    reason: "other_guild",
  });
  expect(messages).toEqual([]);
  expect(other.calls.update + other.calls.reply).toBe(0);
  await handle(click(fakeChannel("thr1", "p"), { guildId: "G1" }).i);
  expect(messages).toHaveLength(1);
});

test("unmapped parent channel: the real task layer refuses and the refusal is posted", async () => {
  const env = makeEnv();
  const sent: string[] = [];
  const ch = fakeChannel("thr1", "100000000000000077");
  ch.send = async (o: any) => void sent.push(o.content);
  const handle = createResumeHandler({
    db: env.db,
    getClient: () => undefined,
    ownerId: OWNER,
    handleMessage: createTurnHandler({ db: env.db, config: env.config }),
  });
  await handle(click(ch).i);
  expect(sent.join("\n")).toContain("This channel is not linked to a workspace");
});
