import { expect, test } from "bun:test";
import { DiscordSurface } from "../src/discord-surface";
import { FakeDiscordPort } from "./fake-discord-port";

const names: Record<string, string> = { ann: "Ann" };
function setup() {
  const port = new FakeDiscordPort();
  const surface = new DiscordSurface(port, (id) => names[id]);
  surface.mapChannel("ch1", { kind: "bot", botId: "ann" });
  const got: { conversationId: string; text: string }[] = [];
  surface.onMessage((m) => got.push(m));
  return { port, surface, got };
}

test("the owner's message in a mapped channel reaches the handler", () => {
  const { port, got } = setup();
  port.emitMessage({ channelId: "ch1", text: "hi" });
  expect(got).toEqual([{ conversationId: "ch1", text: "hi" }]);
});

test("everything else is ignored", () => {
  const { port, got } = setup();
  port.emitMessage({ channelId: "ch1", text: "x", authorId: "stranger" });
  port.emitMessage({ channelId: "ch1", text: "x", fromBotOrWebhook: true });
  port.emitMessage({ channelId: "other", text: "x" });
  port.emitMessage({ channelId: "ch1", text: "   " });
  expect(got).toEqual([]);
});

test("an unmapped channel stops delivering", () => {
  const { port, surface, got } = setup();
  surface.unmapChannel("ch1");
  port.emitMessage({ channelId: "ch1", text: "hi" });
  expect(got).toEqual([]);
});

test("a bot post goes out under the bot's name, an unknown bot under its id, system as the app", async () => {
  const { port, surface } = setup();
  await surface.post("ch1", { author: { kind: "bot", botId: "ann" }, text: "hello" });
  await surface.post("ch1", { author: { kind: "bot", botId: "zed" }, text: "yo" });
  await surface.post("ch1", { author: { kind: "system" }, text: "notice" });
  expect(port.sentAs.map((s) => [s.username, s.text])).toEqual([
    ["Ann", "hello"],
    ["zed", "yo"],
  ]);
  expect(port.sent).toEqual([{ channelId: "ch1", text: "notice" }]);
});

test("a reply over 2000 chars arrives whole, in order", async () => {
  const { port, surface } = setup();
  const text = Array.from({ length: 400 }, (_, i) => `row ${i} ${"y".repeat(8)}`).join("\n");
  await surface.post("ch1", { author: { kind: "bot", botId: "ann" }, text });
  expect(port.sentAs.length).toBeGreaterThan(1);
  for (const s of port.sentAs) expect(s.text.length).toBeLessThanOrEqual(2000);
  expect(port.sentAs.map((s) => s.text).join("\n")).toBe(text);
});

test("typing shows in the channel and a failing typing call is swallowed", () => {
  const { port, surface } = setup();
  surface.showActivity("ch1", { kind: "typing", botId: "ann" });
  expect(port.typings).toEqual(["ch1"]);
  port.failNext("typing");
  expect(() => surface.showActivity("ch1", { kind: "typing", botId: "ann" })).not.toThrow();
});
