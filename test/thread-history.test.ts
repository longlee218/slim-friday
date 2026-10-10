import { expect, test } from "bun:test";
import {
  createMessageHandler,
  FETCH_RECENT_TIMEOUT_MS,
  type Task,
} from "../src/ingress/discord-message-handler";
import { fetchRecent, type HistoryMessage, toRecent } from "../src/ingress/thread-history";
import { BRIEF_RECENT_CHARS, cleanRecent, recentBlock } from "../src/intent/recent-messages";

const P = { currentId: "cur", ownerId: "o", botId: "b" };
const m = (id: string, author: string, content: string, ts: number, files = 0): HistoryMessage => ({
  id,
  author: { id: author },
  content,
  createdTimestamp: ts,
  attachments: { size: files },
});

test("toRecent: oldest first, skips the current message and strangers, [file] marker, drops empty (embed-only)", () => {
  const out = toRecent(
    [
      m("cur", "o", "the current one", 9),
      m("3", "b", "bot answer", 3),
      m("1", "o", "first", 1),
      m("x", "stranger", "noise", 2),
      m("4", "b", "", 4), // embed / button only
      m("5", "o", "see this", 5, 1),
      m("6", "o", "", 6, 1),
    ],
    P,
  );
  expect(out).toEqual([
    { from: "owner", text: "first" },
    { from: "bot", text: "bot answer" },
    { from: "owner", text: "see this [file]" },
    { from: "owner", text: "[file]" },
  ]);
});

test("toRecent / cleanRecent: last 4 only, redacted, each <= 300 chars, whitespace collapsed", () => {
  const many = Array.from({ length: 6 }, (_, i) => m(`${i}`, "o", `msg ${i}`, i));
  expect(toRecent(many, P).map((r) => r.text)).toEqual(["msg 2", "msg 3", "msg 4", "msg 5"]);
  const long = cleanRecent([
    { from: "bot", text: `${"x".repeat(500)}` },
    { from: "owner", text: "key sk-ant-abcdefghijklmnop123456  and\n\nnewline" },
  ]);
  expect(long[0]?.text).toHaveLength(300);
  expect(long[1]?.text).not.toContain("sk-ant-abcdefghijklmnop123456");
  expect(long[1]?.text).not.toContain("\n");
});

test("recentBlock: heading, newest lines that fit 1200 chars, empty when none", () => {
  expect(recentBlock(undefined)).toBe("");
  expect(recentBlock([])).toBe("");
  const small = recentBlock([{ from: "owner", text: "hi" }]);
  expect(small).toBe("\n\nRecent conversation (data):\n- owner: hi");
  const big = recentBlock(
    Array.from({ length: 4 }, (_, i) => ({ from: "bot" as const, text: `${i}`.repeat(300) })),
  );
  expect(big.length).toBeLessThanOrEqual(
    BRIEF_RECENT_CHARS + "\n\nRecent conversation (data):\n".length,
  );
  expect(big).toContain("3".repeat(300)); // the newest survives
});

test("fetchRecent never throws: a failing or missing fetch is no history", async () => {
  const bad = { messages: { fetch: async () => Promise.reject(new Error("403")) } };
  expect(await fetchRecent(bad, P)).toEqual([]);
  expect(await fetchRecent({} as never, P)).toEqual([]);
  const ok = {
    messages: {
      fetch: async (o: { limit: number }) => (
        expect(o.limit).toBe(6), new Map([["1", m("1", "o", "hey", 1)]])
      ),
    },
  };
  expect(await fetchRecent(ok, P)).toEqual([{ from: "owner", text: "hey" }]);
});

test("ingress: a message in a bot thread reaches the task layer with the thread's recent messages", async () => {
  const tasks: Task[] = [];
  const onMessage = createMessageHandler({
    ownerId: "o",
    botId: () => "b",
    handleTask: async (t) => {
      tasks.push(t);
      return "ok";
    },
  });
  const sent: any[] = [];
  const history = new Map([
    ["1", m("1", "o", "what about caching?", 1)],
    ["2", m("2", "b", "Option B: cache 5 min", 2)],
    ["cur", m("cur", "o", "do that", 3)],
  ]);
  const thread: any = {
    id: "thr",
    isThread: () => true,
    ownerId: "b",
    parentId: "chan",
    isSendable: () => true,
    send: async (o: any) => sent.push(o),
    sendTyping: async () => {},
    messages: { fetch: async () => history },
  };
  await onMessage({
    id: "cur",
    author: { id: "o", bot: false },
    content: "do that",
    channel: thread,
    guildId: "G",
    inGuild: () => true,
    mentions: { has: () => false },
  } as never);
  expect(tasks[0]?.text).toBe("do that");
  expect(tasks[0]?.recent).toEqual([
    { from: "owner", text: "what about caching?" },
    { from: "bot", text: "Option B: cache 5 min" },
  ]);
});

/** A thread whose history fetch never resolves (or fails), recording whether it was called. */
async function threadRun(content: string, fetch: () => Promise<unknown>) {
  const tasks: Task[] = [];
  const onMessage = createMessageHandler({
    ownerId: "o",
    botId: () => "b",
    handleTask: async (t) => {
      tasks.push(t);
      return "ok";
    },
  });
  let fetched = 0;
  const thread: any = {
    id: "thr",
    isThread: () => true,
    ownerId: "b",
    parentId: "chan",
    isSendable: () => true,
    send: async () => {},
    sendTyping: async () => {},
    messages: { fetch: () => (fetched++, fetch()) },
  };
  const t0 = Date.now();
  await onMessage({
    id: "cur",
    author: { id: "o", bot: false },
    content,
    channel: thread,
    guildId: "G",
    inGuild: () => true,
    mentions: { has: () => false },
  } as never);
  return { tasks, fetched, ms: Date.now() - t0 };
}

test("commands (slash and legacy) never wait for or call the history fetch", async () => {
  for (const c of ["/stop", "stop", "/go +1", "/cleanup", "/remember a long note here"]) {
    const r = await threadRun(c, () => new Promise(() => {}));
    expect(r.fetched).toBe(0);
    expect(r.ms).toBeLessThan(500);
  }
});

test("a hanging history fetch times out (empty recent) and a failing one is ignored; the message proceeds", async () => {
  const hang = await threadRun("do that", () => new Promise(() => {}));
  expect(hang.fetched).toBe(1);
  expect(hang.tasks[0]?.text).toBe("do that");
  expect(hang.tasks[0]?.recent).toBeUndefined();
  expect(hang.ms).toBeGreaterThanOrEqual(FETCH_RECENT_TIMEOUT_MS - 100);
  expect(hang.ms).toBeLessThan(FETCH_RECENT_TIMEOUT_MS + 1500);
  const bad = await threadRun("do that", () => Promise.reject(new Error("403")));
  expect(bad.tasks[0]?.recent).toBeUndefined();
});
