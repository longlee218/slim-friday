import { expect, test } from "bun:test";
import type { SendableChannels } from "discord.js";
import { TONE_COLOR } from "../src/providers/discord/ui/components/tone";
import { sendReply, sendResultFile } from "../src/providers/discord/ui/send/send-port";

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

test("sendResultFile with a viewer link: one green Container (title, italic excerpt, Open link), no file", async () => {
  const sent: any[] = [];
  const channel = {
    send: async (o: unknown) => void sent.push(o),
    sendTyping: async () => {},
  } as unknown as SendableChannels;
  const body = `# Báo cáo\n\n${"nội dung dài ".repeat(200)}`;
  await sendResultFile(channel, body, "vi", undefined, "bao-cao.md", [
    { label: "Open", url: "https://v.example/a/1?e=1&s=2" },
  ]);
  expect(sent[0].files).toBeUndefined();
  const box = sent[0].components[0].toJSON();
  expect(box.accent_color).toBe(TONE_COLOR.ok);
  const text = box.components.find((c: any) => c.type === 10).content as string;
  expect(text).toContain("**Báo cáo**");
  expect(text).toContain("*nội dung");
  expect(text).toContain("-# Kết quả đầy đủ");
  expect(text.length).toBeLessThan(900); // excerpt only, the rest is behind the link
  expect(JSON.stringify(box.components.find((c: any) => c.type === 1))).toContain(
    "https://v.example",
  );
});
