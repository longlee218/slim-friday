import { expect, test } from "bun:test";
import { createMessageHandler } from "../src/ingress/discord-message-handler";
import { BUSY_ACK_EMOJI } from "../src/ingress/discord-send";
import { reactDoneOf, STEER_READ_EMOJI } from "../src/ingress/message-reaction";
import { createSlashHandler } from "../src/ingress/slash-interaction";
import { renderStatus } from "../src/ingress/status-copy";
import { STEER_REACT_REPLY } from "../src/orchestrator/thread/steer-notice-sentinel";
import { waitingTaskSnapshot } from "../src/orchestrator/turns/status-snapshot";
import { decideRoute } from "../src/routing/routing-policy";
import {
  BG,
  haiku,
  input,
  pipeline,
  proposer,
  VAGUE,
  verdict,
  waitingTask,
} from "./routing-policy-fixtures";

test("the read reaction is not the busy receipt emoji (the receipt would remove it)", () => {
  expect(STEER_READ_EMOJI).not.toBe(BUSY_ACK_EMOJI);
});

test("jev + Haiku names the waiting owner's role with question: no continuation", async () => {
  const env = waitingTask();
  const h = haiku(verdict({ role: BG, scope: "active", question: true }));
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: h.classifier,
    engine: "jev",
    proposer: proposer({ kind: "undecided", reason: "low_confidence" }).impl,
  });
  expect(plan.continueTask).toBeUndefined();
  expect(plan.routing.rationaleCode).not.toBe("CONTEXT_CONTINUATION");
});

test("waiting task snapshot: empty without a waiting task, facts with one", () => {
  expect(waitingTaskSnapshot(waitingTask().db, "other-thread")).toBe("");
  const env = waitingTask();
  const block = waitingTaskSnapshot(env.db, "th");
  expect(block).toContain("waiting task");
  expect(block).toContain(`role ${BG}`);
  expect(block).toContain("waiting_user");
});

test("/status of a waiting task without a role does not print an empty role", () => {
  const text = renderStatus(
    { running: false, role: "", taskStatus: "waiting_user", seconds: 5, toolCount: 0, recent: [] },
    "en",
  );
  expect(text).toContain("Waiting task (waiting_user)");
  expect(text).not.toContain("(,");
});

test("reactDoneOf: safe on a message with no react (slash stand-in), reacts on a real one", async () => {
  await reactDoneOf({} as never)();
  const got: string[] = [];
  await reactDoneOf({ react: async (e: string) => void got.push(e) } as never)();
  expect(got).toEqual(["✅"]);
});

test("slash steer repeated within 60 s (react sentinel) posts no failure", async () => {
  const OWNER = "111";
  const BOT = "999";
  const onMessage = createMessageHandler({
    ownerId: OWNER,
    botId: () => BOT,
    guildId: "G1",
    handleMessage: async () => STEER_REACT_REPLY,
  });
  const handle = createSlashHandler({ ownerId: OWNER, onMessage });
  const log: string[] = [];
  const sent: unknown[] = [];
  const channel: any = {
    id: "T1",
    isThread: () => true,
    ownerId: BOT,
    parentId: "C1",
    isSendable: () => true,
    send: async (o: unknown) => void sent.push(o),
    sendTyping: async () => {},
  };
  const i: any = {
    id: "I1",
    commandName: "stop",
    user: { id: OWNER, bot: false },
    channel,
    channelId: "T1",
    guildId: "G1",
    guild: {},
    inGuild: () => true,
    isChatInputCommand: () => true,
    options: { get: () => null },
    reply: async () => {},
    deferReply: async () => void log.push("defer"),
    editReply: async (o: any) => void log.push(`edit:${typeof o === "string" ? o : o.content}`),
    deleteReply: async () => void log.push("delete"),
  };
  await handle(i);
  expect(sent).toEqual([]);
  expect(log.filter((l) => l.startsWith("edit:"))).toEqual([]);
});
