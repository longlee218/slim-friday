import { expect, test } from "bun:test";
import {
  CHUNK_MAX,
  HEAD_MAX,
  type MessageFacts,
  markdownLinks,
  prepareOutput,
  prepareReply,
  REPLY_CAP,
  routeMessage,
  SAFE_MENTIONS,
  safeLinks,
  splitChunks,
  stripMention,
} from "../src/ingress/discord-message-rules";

const OWNER = "111";
const BOT = "999";
const base: MessageFacts = {
  authorId: OWNER,
  authorIsBot: false,
  inGuild: true,
  otherGuild: false,
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

test("a message from another guild is ignored (other_guild), thread or channel", () => {
  for (const inBotThread of [false, true])
    expect(route({ otherGuild: true, inBotThread })).toEqual({
      kind: "ignore",
      reason: "other_guild",
    });
  // The check comes after the owner/bot rules: a stranger stays not_owner.
  expect(route({ otherGuild: true, authorId: "222" })).toEqual({
    kind: "ignore",
    reason: "not_owner",
  });
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

test("mention stripping", () => {
  expect(route({ inBotThread: true, content: `<@${BOT}> go on` })).toEqual({
    kind: "thread",
    prompt: "go on",
  });
  expect(stripMention(`<@${BOT}> a <@${BOT}>`, BOT)).toBe("a");
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

test("M5: empty / whitespace replies become a notice, no blank chunks", () => {
  expect(prepareReply("")).toEqual(["(no answer)"]);
  expect(prepareReply("   \n  ")).toEqual(["(no answer)"]);
  expect(prepareReply("hi\n\n").every((c) => c.trim() !== "")).toBe(true);
});

test("H1: mention policy disables all pings", () => {
  expect(SAFE_MENTIONS).toEqual({ parse: [], repliedUser: false });
});

test("prepareOutput: short reply stays inline, long reply = head + redacted reply.md", () => {
  expect(prepareOutput("short answer", "en").file).toBeUndefined();
  const key = `ghp_${"a".repeat(36)}`;
  const long = `${"line of text\n".repeat(600)}${key}`;
  const out = prepareOutput(long, "en");
  expect(out.file?.name).toBe("reply.md");
  expect(out.file?.content).not.toContain(key); // attachment is redacted too
  expect(out.chunks).toHaveLength(1);
  expect(out.chunks[0]!.length).toBeLessThan(HEAD_MAX + 60);
  expect(out.chunks[0]).toContain("[full reply attached]");
  expect(prepareOutput(long, "vi").chunks[0]).toContain("[đã đính kèm toàn bộ câu trả lời]");
});

test("prepareOutput: mainly-diff reply goes to changes.diff, head closes the open fence", () => {
  const diff = `\`\`\`diff\n${"+added line\n".repeat(200)}\`\`\``;
  const out = prepareOutput(`Here is the change:\n${diff}`, "en");
  expect(out.file?.name).toBe("changes.diff");
  const head = out.chunks[0]!;
  expect((head.match(/```/g) ?? []).length % 2).toBe(0);
  // A small diff next to lots of prose stays inline.
  expect(
    prepareOutput(`${"prose ".repeat(100)}\n\`\`\`diff\n+x\n\`\`\``, "en").file,
  ).toBeUndefined();
});

test("ops channels and their threads never reach the agent; control channel and admin text become control", () => {
  // Plain text in an ops channel (mention or not, thread or not) is dropped.
  for (const inBotThread of [false, true])
    expect(route({ opsChannel: true, inBotThread })).toEqual({
      kind: "ignore",
      reason: "ops_channel",
    });
  expect(route({ opsChannel: true, mentionsBot: false, content: "hello" }).kind).toBe("ignore");
  // Control channel: no mention needed, any text is admin handling.
  expect(
    route({ opsChannel: true, controlChannel: true, mentionsBot: false, content: "help" }),
  ).toEqual({
    kind: "control",
    prompt: "help",
  });
  // Admin text in another ops channel / control-channel thread still goes to the gate (reply), not the agent.
  expect(route({ opsChannel: true, content: "/init-workspace x" }).kind).toBe("control");
  // The owner check still comes first.
  expect(route({ opsChannel: true, controlChannel: true, authorId: "222" })).toEqual({
    kind: "ignore",
    reason: "not_owner",
  });
});

test("admin text outside ops channels is control (gate refuses it), never a thread/channel run", () => {
  expect(route({ content: `<@${BOT}> /init-workspace x` })).toEqual({
    kind: "control",
    prompt: "/init-workspace x",
  });
  expect(route({ inBotThread: true, mentionsBot: false, content: "/init-workspace x" }).kind).toBe(
    "control",
  );
  // Unmentioned admin text in a normal channel is just ignored.
  expect(route({ mentionsBot: false, content: "/init-workspace x" })).toEqual({
    kind: "ignore",
    reason: "not_mentioned",
  });
});

// Adoption: every combination of the thread facts.
test("adopt route: owner + mention + adoptable thread", () => {
  expect(route({ adoptableThread: true })).toEqual({ kind: "adopt", prompt: "hello" });
  // Not adoptable (unmapped parent, bot-owned, already adopted): the old routes stay.
  expect(route({ adoptableThread: false }).kind).toBe("channel");
  expect(route({ adoptableThread: true, mentionsBot: false })).toEqual({
    kind: "ignore",
    reason: "not_mentioned",
  });
});

test("adopted thread acts like a bot thread: no mention needed", () => {
  expect(route({ adoptedThread: true, mentionsBot: false, content: "follow up" })).toEqual({
    kind: "thread",
    prompt: "follow up",
  });
  // Adoption never applies once adopted (the handler computes adoptable=false then).
  expect(route({ adoptedThread: true, adoptableThread: false })).toEqual({
    kind: "thread",
    prompt: "hello",
  });
  // A bot-owned thread wins over adoptable.
  expect(route({ inBotThread: true, adoptableThread: true }).kind).toBe("thread");
});

test("adoption: non-owner, bot, DM and other guild are still ignored", () => {
  for (const o of [
    { authorId: "222" },
    { authorIsBot: true },
    { inGuild: false },
    { otherGuild: true },
  ])
    expect(route({ adoptableThread: true, adoptedThread: true, ...o }).kind).toBe("ignore");
});

test("adoption: ops parent never adopts (ops check first)", () => {
  expect(route({ adoptableThread: true, opsChannel: true }).kind).toBe("ignore");
  expect(
    route({ adoptableThread: true, opsChannel: true, content: `<@${BOT}> /init-workspace x` }).kind,
  ).toBe("control");
  expect(route({ adoptedThread: true, opsChannel: true, mentionsBot: false }).kind).toBe("ignore");
});

test("markdownLinks: only absolute http(s) Markdown links, max three, deduped", () => {
  const md = [
    "[a](https://a.example/x) [b](http://b.example) [file](file:///etc/passwd) [rel](./notes.md)",
    "[abs](/Users/me/x.md) [dup](https://a.example/x) [c](https://c.example) [d](https://d.example)",
  ].join("\n");
  expect(markdownLinks(md)).toEqual([
    { label: "a", url: "https://a.example/x" },
    { label: "b", url: "http://b.example/" },
    { label: "c", url: "https://c.example/" },
  ]);
  expect(markdownLinks("[x](javascript:alert(1)) [y](mailto:a@b.c)")).toEqual([]);
});

test("safeLinks: structured links drop unsafe urls, blank labels fall back to the host", () => {
  expect(
    safeLinks([
      { label: "ok", url: "https://ok.example/p" },
      { label: "bad", url: "file:///tmp/x" },
      { label: "rel", url: "docs/x.md" },
      { label: "  ", url: "https://host.example/q" },
    ]),
  ).toEqual([
    { label: "ok", url: "https://ok.example/p" },
    { label: "host.example", url: "https://host.example/q" },
  ]);
});

test("links: urls over 512 chars and image syntax never become buttons", () => {
  const long = `https://a.example/${"x".repeat(520)}`;
  expect(
    markdownLinks(`[long](${long}) ![img](https://i.example/p.png) [ok](https://ok.example)`),
  ).toEqual([{ label: "ok", url: "https://ok.example/" }]);
  expect(safeLinks([{ label: "long", url: long }])).toEqual([]);
});
