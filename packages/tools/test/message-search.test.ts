import { expect, test } from "bun:test";
import type { Conversation, IndexedMessage } from "@friday/core";
import type { ToolSessionContext } from "../src/memory/memory-owner";
import { catchUpMessages } from "../src/memory/recall/message-catch-up";
import { createMessageSearchTool } from "../src/memory/tools/MessageSearchTool/message-search-tool";
import { FakeMessageIndex } from "./fake-index-store";

const at = (s: string) => new Date(s).getTime();
const msg = (
  id: number,
  conversationId: string,
  text: string,
  when = "2026-10-20T09:05:00",
): IndexedMessage => ({
  id,
  conversationId,
  author: id % 2 ? { kind: "user" } : { kind: "bot", botId: "ann" },
  text,
  at: at(when),
});
const convs: Record<string, Conversation> = {
  "dm-ann": { id: "dm-ann", kind: "direct", botId: "ann" },
  g1: { id: "g1", kind: "group", groupId: "team" },
};
const ctx = (current?: string): ToolSessionContext => ({
  botId: "ann",
  conversation: async () => (current ? convs[current] : undefined),
  group: async () => undefined,
  direct: async () => convs["dm-ann"],
});
type Result = { content: { text: string }[]; isError?: boolean };
const run = (t: ReturnType<typeof createMessageSearchTool>, a: object) =>
  t.handler(a as never, {}) as Promise<Result>;

/** A source of stored messages that pages like `messages.after`. */
const sourceOf = (rows: IndexedMessage[]) => {
  let calls = 0;
  return {
    calls: () => calls,
    after: async (afterId: number, limit: number) => {
      calls++;
      return rows.filter((r) => r.id > afterId).slice(0, limit);
    },
  };
};

test("catchUpMessages pages through after() until empty and is idempotent", async () => {
  const rows = Array.from({ length: 1203 }, (_, i) => msg(i + 1, "g1", `note ${i}`));
  const index = new FakeMessageIndex();
  const source = sourceOf(rows);
  expect(await catchUpMessages(source, index)).toBe(1203);
  expect(index.lastMessageId()).toBe(1203);
  expect(await catchUpMessages(source, index)).toBe(0);
});

test("MessageSearch searches the current conversation and the bot's direct chat only", async () => {
  const index = new FakeMessageIndex();
  index.addMessages([
    msg(1, "dm-ann", "docker in dm"),
    msg(3, "g1", "docker in group"),
    msg(5, "dm-bob", "docker secret of bob"),
  ]);
  const t = createMessageSearchTool({ index, catchUp: async () => {} }, ctx("g1"));
  const text = (await run(t, { query: "docker" })).content[0]?.text ?? "";
  expect(text).toContain("docker in dm");
  expect(text).toContain("docker in group");
  expect(text).not.toContain("bob");
  const fromDm =
    (
      await run(createMessageSearchTool({ index, catchUp: async () => {} }, ctx("dm-ann")), {
        query: "docker",
      })
    ).content[0]?.text ?? "";
  expect(fromDm).not.toContain("docker in group");
});

test("MessageSearch lines read [YYYY-MM-DD HH:MM author] text, cut at 300 chars; no match otherwise", async () => {
  const index = new FakeMessageIndex();
  index.addMessages([
    msg(1, "g1", `docker ${"x".repeat(400)}`),
    msg(2, "g1", "docker by bot", "2026-10-21T14:30:00"),
  ]);
  const t = createMessageSearchTool({ index, catchUp: async () => {} }, ctx("g1"));
  const lines = ((await run(t, { query: "docker" })).content[0]?.text ?? "").split("\n");
  expect(lines).toContain("[2026-10-21 14:30 ann] docker by bot");
  const long = lines.find((l) => l.startsWith("[2026-10-20 09:05 user] docker"));
  expect(long?.length).toBe("[2026-10-20 09:05 user] ".length + 300);
  expect((await run(t, { query: "nothing here" })).content[0]?.text).toBe("no match");
});

test("MessageSearch runs catchUp first, and a catchUp failure still searches what is indexed", async () => {
  const index = new FakeMessageIndex();
  index.addMessages([msg(1, "g1", "docker old")]);
  let ran = false;
  const ok = createMessageSearchTool(
    {
      index,
      catchUp: async () => {
        ran = true;
        index.addMessages([msg(3, "g1", "docker new")]);
      },
    },
    ctx("g1"),
  );
  expect((await run(ok, { query: "docker" })).content[0]?.text).toContain("docker new");
  expect(ran).toBe(true);
  const failing = createMessageSearchTool(
    {
      index,
      catchUp: async () => {
        throw new Error("db busy");
      },
    },
    ctx("g1"),
  );
  const r = await run(failing, { query: "docker" });
  expect(r.isError).toBeUndefined();
  expect(r.content[0]?.text).toContain("docker old");
});

test("input: query 2..200 chars", () => {
  const t = createMessageSearchTool(
    { index: new FakeMessageIndex(), catchUp: async () => {} },
    ctx("g1"),
  );
  expect(t.inputSchema.query.safeParse("d").success).toBe(false);
  expect(t.inputSchema.query.safeParse("x".repeat(201)).success).toBe(false);
  expect(t.inputSchema.query.safeParse("docker").success).toBe(true);
});
