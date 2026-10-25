import { expect, test } from "bun:test";
import type { BotMessenger, SendRequest, SendResult } from "@friday/core";
import type { ChatContext } from "../src/chat/chat-context";
import { chatTools } from "../src/chat/chat-server";
import { createHandOffTool } from "../src/chat/tools/HandOffTool/hand-off-tool";
import { createSendToBotTool } from "../src/chat/tools/SendToBotTool/send-to-bot-tool";
import { call, textOf } from "./design-fixture";

/** A messenger that records what it got and answers `result`. */
function fake(result: SendResult = { ok: true, wakeId: "w1", note: "Sent to Editor." }) {
  const sent: { from: string; req: SendRequest }[] = [];
  const messenger: BotMessenger = {
    send: async (from, req) => {
      sent.push({ from, req });
      return result;
    },
  };
  return { sent, ctx: { botId: "writer", messenger } as unknown as ChatContext };
}

test("SendToBot passes to, message and intent to the messenger and returns its note", async () => {
  const { sent, ctx } = fake();
  const r = await call(createSendToBotTool(ctx), {
    to: "editor",
    message: "cut it",
    intent: "request",
  });
  expect(r.isError).toBeUndefined();
  expect(textOf(r)).toBe("Sent to Editor.");
  expect(sent).toEqual([
    { from: "writer", req: { to: "editor", text: "cut it", intent: "request" } },
  ]);
});

test("a refusal comes back as an error result with the reason", async () => {
  const { ctx } = fake({ ok: false, error: "A bot cannot message itself." });
  const r = await call(createSendToBotTool(ctx), { to: "writer", message: "x", intent: "fyi" });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toBe("A bot cannot message itself.");
});

test("HandOff calls the messenger with handoff: true and intent request", async () => {
  const { sent, ctx } = fake();
  await call(createHandOffTool(ctx), { to: "Editor", task: "edit the draft" });
  expect(sent[0]?.req).toEqual({
    to: "Editor",
    text: "edit the draft",
    intent: "request",
    handoff: true,
  });
});

test("a bot without a messenger (in no group) is not offered SendToBot or HandOff", () => {
  const names = (ctx: Partial<ChatContext>) =>
    chatTools({ runKind: "bot", ...ctx } as ChatContext).map((t) => t.name);
  expect(names({})).toEqual(["PostFile", "SetEffort"]);
  expect(names(fake().ctx)).toEqual(["PostFile", "SetEffort", "SendToBot", "HandOff"]);
});
