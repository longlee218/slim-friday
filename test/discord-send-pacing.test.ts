import { expect, test } from "bun:test";
import type { SendableChannels } from "discord.js";
import { sendReply, sendResultFile } from "../src/ingress/discord-send";

/** Fake channel: records every send and typing call in order. */
function fakeChannel() {
  const log: string[] = [];
  const channel = {
    send: async (o: { content?: string; components?: unknown[] }) => {
      log.push(o.components ? "report" : `send:${o.content}`);
    },
    sendTyping: async () => {
      log.push("typing");
    },
  };
  return { log, channel: channel as unknown as SendableChannels };
}

test("sendReply: one message per paragraph, typing + pause between, visible once after the first", async () => {
  const { log, channel } = fakeChannel();
  const pauses: number[] = [];
  const visible = async () => {
    log.push("visible");
  };
  await sendReply(channel, "một\n\nhai\n\nba", "vi", visible, async (ms) => {
    pauses.push(ms);
  });
  expect(log).toEqual(["send:một", "visible", "typing", "send:hai", "typing", "send:ba"]);
  expect(pauses).toHaveLength(2);
  for (const ms of pauses) expect(ms).toBeGreaterThanOrEqual(800);
  expect(pauses[0]! + pauses[1]!).toBeLessThanOrEqual(6000);
});

test("sendReply: a reply with details ends with a report message (file component)", async () => {
  const { log, channel } = fakeChannel();
  await sendReply(
    channel,
    "xong rồi\n\ncó chi tiết\n---\n# Chi tiết",
    "vi",
    undefined,
    async () => {},
  );
  expect(log).toEqual(["send:xong rồi", "typing", "report"]);
});

test("sendReply: a single long reply is one report message, no pause", async () => {
  const { log, channel } = fakeChannel();
  const pauses: number[] = [];
  await sendReply(channel, "y".repeat(900), "en", undefined, async (ms) => {
    pauses.push(ms);
  });
  expect(log).toEqual(["report"]);
  expect(pauses).toEqual([]);
});

test("sendResultFile: one report message with the localized label, visible once", async () => {
  const { log, channel } = fakeChannel();
  const sent: unknown[] = [];
  const spy = channel as unknown as { send: (o: unknown) => Promise<void> };
  const orig = spy.send;
  spy.send = async (o) => {
    sent.push(o);
    return orig(o as never);
  };
  await sendResultFile(channel, "full result", "vi", async () => void log.push("visible"));
  expect(log).toEqual(["report", "visible"]);
  expect(JSON.stringify(sent[0])).toContain("Kết quả đầy đủ");
  expect((sent[0] as { files: { name: string }[] }).files[0]!.name).toBe("reply.md");
  await sendResultFile(channel, "x", "vi", undefined, "giao-an.md");
  expect((sent[1] as { files: { name: string }[] }).files[0]!.name).toBe("giao-an.md");
});
