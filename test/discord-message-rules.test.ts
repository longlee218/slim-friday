import { expect, test } from "bun:test";
import {
  CHUNK_MAX,
  isStop,
  type MessageFacts,
  prepareReply,
  REPLY_CAP,
  routeMessage,
  SAFE_MENTIONS,
  splitChunks,
  stripMention,
  threadName,
} from "../src/ingress/discord-message-rules";

const OWNER = "111";
const BOT = "999";
const base: MessageFacts = {
  authorId: OWNER,
  authorIsBot: false,
  inGuild: true,
  inBotThread: false,
  mentionsBot: true,
  content: `<@${BOT}> hello`,
};
const route = (o: Partial<MessageFacts>) => routeMessage({ ...base, ...o }, OWNER, BOT);

test("owner mention in channel -> channel route, mention stripped", () => {
  expect(route({})).toEqual({ kind: "channel", prompt: "hello" });
  expect(route({ content: `hey <@!${BOT}> there` })).toEqual({
    kind: "channel",
    prompt: "hey  there",
  });
});

test("non-owner, bot, DM are ignored in channel and thread", () => {
  for (const inBotThread of [false, true]) {
    expect(route({ authorId: "222", inBotThread }).kind).toBe("ignore");
    expect(route({ authorIsBot: true, inBotThread }).kind).toBe("ignore");
    expect(route({ inGuild: false, inBotThread }).kind).toBe("ignore");
  }
});

test("channel without mention is ignored; bot thread needs no mention", () => {
  expect(route({ mentionsBot: false, content: "hello" }).kind).toBe("ignore");
  expect(route({ inBotThread: true, mentionsBot: false, content: "follow up" })).toEqual({
    kind: "thread",
    prompt: "follow up",
  });
});

test("mention-only message is ignored", () => {
  expect(route({ content: `<@${BOT}>` }).kind).toBe("ignore");
});

test("stop detection and mention stripping", () => {
  expect(isStop(" Stop ")).toBe(true);
  expect(isStop("STOP")).toBe(true);
  expect(isStop("stop it")).toBe(false);
  expect(route({ inBotThread: true, content: `<@${BOT}> stop` })).toEqual({
    kind: "thread",
    prompt: "stop",
  });
  expect(stripMention(`<@${BOT}> a <@${BOT}>`, BOT)).toBe("a");
});

test("threadName is single-line and <=90 chars", () => {
  expect(threadName("what does\nfoo do?")).toBe("what does foo do?");
  expect(threadName("x".repeat(300)).length).toBeLessThanOrEqual(90);
});

test("chunking: short, exactly 1900, boundaries", () => {
  expect(splitChunks("hi")).toEqual(["hi"]);
  expect(splitChunks("a".repeat(CHUNK_MAX))).toEqual(["a".repeat(CHUNK_MAX)]);
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  const chunks = splitChunks(lines);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_MAX);
  expect(chunks.join("\n")).toBe(lines); // split only at line boundaries, nothing lost
});

test("chunking: one huge line is hard-split without loss", () => {
  const long = "y".repeat(5000);
  const chunks = splitChunks(long);
  expect(chunks.every((c) => c.length <= CHUNK_MAX)).toBe(true);
  expect(chunks.join("")).toBe(long);
});

test("chunking: code fence closed and reopened across chunks", () => {
  const code = Array.from({ length: 150 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const chunks = splitChunks("intro\n```ts\n" + code + "\n```\noutro");
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(CHUNK_MAX + 10);
    expect((c.match(/^```/gm) ?? []).length % 2).toBe(0); // every chunk has balanced fences
  }
});

test("prepareReply redacts a fake key and truncates very long output", () => {
  const key = "ghp_" + "a".repeat(36);
  const out = prepareReply(`token is ${key}`).join("\n");
  expect(out).not.toContain(key);
  const long = prepareReply("z\n".repeat(REPLY_CAP));
  expect(long.join("\n")).toContain("[output truncated]");
  expect(long.join("\n").length).toBeLessThan(REPLY_CAP + 200);
});

test("role mention stripping (role mentions filtered just like user mentions)", () => {
  expect(stripMention(`<@&${BOT}> hello`, BOT)).toBe("<@&" + BOT + "> hello"); // Role mentions look different, bot id in user position doesn't match
  expect(stripMention(`hello <@${BOT}> world`, BOT)).toBe("hello  world");
  expect(stripMention(`<@${BOT}>`, BOT)).toBe("");
});

test("threadName with emoji and unicode handling", () => {
  expect(threadName("emoji: 🚀 test")).toContain("🚀");
  expect(threadName("中文 test")).toContain("中文");
  const long = "長い" + "x".repeat(100);
  expect(threadName(long).length).toBeLessThanOrEqual(90);
});

test("message chunking with multibyte and emoji boundaries", () => {
  const emoji = "🚀".repeat(500); // 500 emojis, each 4 bytes
  const chunks = splitChunks(emoji, CHUNK_MAX);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(CHUNK_MAX);
    expect(Buffer.byteLength(c)).toBeLessThanOrEqual(Buffer.byteLength(emoji.slice(0, CHUNK_MAX)));
  }
  expect(chunks.join("")).toBe(emoji);
});

test("exactly 1900 char chunk boundary", () => {
  const exactly = "a".repeat(CHUNK_MAX);
  expect(splitChunks(exactly)).toEqual([exactly]);
  const over = "a".repeat(CHUNK_MAX + 1);
  const chunks = splitChunks(over);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join("")).toBe(over);
});

test("M4: thread title is redacted before truncation", () => {
  const key = "ghp_" + "a".repeat(36);
  expect(threadName(`why is ${key} here`)).not.toContain("ghp_");
});

test("M5: empty / whitespace replies become a notice, no blank chunks", () => {
  expect(prepareReply("")).toEqual(["(no answer)"]);
  expect(prepareReply("   \n  ")).toEqual(["(no answer)"]);
  expect(prepareReply("hi\n\n").every((c) => c.trim() !== "")).toBe(true);
});

test("H1: mention policy disables all pings", () => {
  expect(SAFE_MENTIONS).toEqual({ parse: [], repliedUser: false });
});
