import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { slashText } from "../src/commands/slash-definitions";
import {
  channelDigestBlock,
  DIGEST_BLOCK_MAX_CHARS,
  DIGEST_HEADING,
} from "../src/memory/channel-digest";
import { createFindRunner, FIND_NONE, FIND_USAGE } from "../src/memory/find-command-handler";
import { openDb } from "../src/storage/db";
import {
  channelDigest,
  recordBotThread,
  saveTitle,
  searchThreads,
  type ThreadRow,
} from "../src/storage/thread-store";
import { addLocation, CHANNEL_2, makeEnv, TEST_CHANNEL } from "./helpers";
import { type Call, teammateHarness, until } from "./teammate-harness";

/** A titled thread row written through the store (the way Orchestrate set_title does). */
const titled = (
  db: ReturnType<typeof openDb>,
  id: string,
  ch: string,
  title: string,
  at: number,
  digest = "",
) => saveTitle(db, id, title, digest, at, ch, "main");

test("channelDigest: newest 5, not the current thread, titled only, one row per thread, never channel ''", () => {
  const db = openDb(":memory:");
  for (let n = 1; n <= 7; n++) titled(db, `t${n}`, "c1", `title ${n}`, n);
  titled(db, "t3", "c1", "title 3 again", 100); // overwrite keeps one row, bumps it
  titled(db, "other", "c2", "elsewhere", 50);
  titled(db, "lost", "", "no channel", 60);
  recordBotThread(db, "untitled", "c1", "main", "p", 70);
  const rows = channelDigest(db, "c1", "t7");
  expect(rows.map((r) => r.thread_id)).toEqual(["t3", "t6", "t5", "t4", "t2"]);
  expect(rows[0]?.title).toBe("title 3 again");
  expect(channelDigest(db, "", "x")).toEqual([]);
});

test("channelDigestBlock: heading + lines, 800 chars max (oldest dropped first), empty -> empty", () => {
  const row = (n: number, text: string): ThreadRow => ({
    thread_id: `t${n}`,
    channel_id: "c1",
    workspace: "main",
    origin: "bot",
    placeholder: null,
    title: `T${n}`,
    digest: text,
    created_at: n,
    updated_at: n,
  });
  expect(channelDigestBlock([])).toEqual({ text: "", entries: 0 });
  const small = channelDigestBlock([row(2, "two"), row(1, "")]);
  expect(small.entries).toBe(2);
  expect(small.text.startsWith(`${DIGEST_HEADING}\n`)).toBe(true);
  expect(small.text).toMatch(/ T2 - two\n\d\d-\d\d T1$/);
  const big = channelDigestBlock([1, 2, 3, 4, 5].map((n) => row(n, "x".repeat(300))));
  expect(big.text.length).toBeLessThanOrEqual(DIGEST_BLOCK_MAX_CHARS);
  expect(big.entries).toBe(2); // newest kept, oldest dropped
  expect(big.text).toContain("T1 -");
  const one = channelDigestBlock([row(1, "y".repeat(2000))]); // a single long line is clipped, not dropped
  expect(one.entries).toBe(1);
  expect(one.text.length).toBeLessThanOrEqual(DIGEST_BLOCK_MAX_CHARS);
});

test("searchThreads: every keyword, case-insensitive (also non-ASCII, NFC), literal, one space, newest first", () => {
  const db = openDb(":memory:");
  titled(db, "a", "c1", "Invoice export", 1, "csv of 100% paid");
  titled(db, "b", "c2", "invoice import", 2);
  titled(db, "c", "c9", "invoice other space", 3);
  titled(db, "d", "", "invoice lost", 4);
  titled(db, "e", "c1", "plain_name", 5);
  saveTitle(db, "f", "invoice other ws", "", 6, "c1", "w2"); // same channel id, another workspace
  saveTitle(db, "g", "HÓA đơn tháng", "", 7, "c1", "main"); // composed accents
  const ids = (ch: string[], w: string[]) =>
    searchThreads(db, "main", ch, w).map((r) => r.thread_id);
  expect(ids(["c1", "c2"], ["INVOICE"])).toEqual(["b", "a"]);
  expect(ids(["c1", "c2"], ["invoice", "csv"])).toEqual(["a"]);
  expect(ids(["c1"], ["100%"])).toEqual(["a"]);
  expect(ids(["c1"], ["%"])).toEqual(["a"]); // not a wildcard
  expect(ids(["c1"], ["p_ain"])).toEqual([]); // `_` is not "any char"
  expect(ids([], ["invoice"])).toEqual([]);
  expect(ids(["c1"], ["hóa"])).toEqual(["g"]); // lower matches upper
  expect(ids(["c1"], ["ho\u0301a"])).toEqual(["g"]); // NFD input matches the NFC title
  expect(ids(["c1"], ["ĐƠN", "THÁNG"])).toEqual(["g"]);
  for (let n = 0; n < 12; n++) titled(db, `m${n}`, "c1", `many ${n}`, 10 + n);
  expect(searchThreads(db, "main", ["c1"], ["many"], 10)).toHaveLength(10);
});

/** The teammate harness (real handler + fake `query`); the fake records each teammate prompt and resume id. */
function runHarness() {
  const h = teammateHarness(() => "answer");
  const calls = h.calls;
  const send = async (threadId: string, text: string) => {
    const n = h.ofKind("teammate").length;
    await h.send(text, threadId);
    await until(() => h.ofKind("teammate").length > n);
    return h.ofKind("teammate")[n] as Call;
  };
  return { env: h.env, calls, send };
}

test("fresh session: first prompt starts with the digest; the resumed turn adds none; other channels excluded", async () => {
  const { env, send } = runHarness();
  titled(env.db, "thA", TEST_CHANNEL, "Fix invoice export", Date.now(), "csv columns");
  titled(env.db, "thX", "999", "Foreign channel", Date.now());
  const first = await send("thB", "hello there");
  expect(first.options.resume).toBeUndefined();
  expect(first.prompt.startsWith(DIGEST_HEADING)).toBe(true);
  expect(first.prompt).toContain("Fix invoice export - csv columns");
  expect(first.prompt).not.toContain("Foreign channel");
  expect(first.prompt.endsWith("hello there\n</owner_message>")).toBe(true);
  const second = await send("thB", "and again");
  expect(second.options.resume).toBeDefined();
  expect(second.prompt).not.toContain(DIGEST_HEADING); // resumed: no new digest block
});

test("no digest rows: no digest block; chat channels skip the digest", async () => {
  const { env, send } = runHarness();
  expect((await send("thB", "plain")).prompt).not.toContain(DIGEST_HEADING);
  // The same channel as a chat-mode channel of the space.
  const ws = env.paths.workspace("main");
  const doc = Bun.YAML.parse(await Bun.file(ws.config).text()) as Record<string, unknown>;
  writeFileSync(
    ws.config,
    Bun.YAML.stringify({ ...doc, channels: [{ id: TEST_CHANNEL, name: "chat", mode: "chat" }] }),
  );
  titled(env.db, "thA", TEST_CHANNEL, "Earlier", Date.now());
  expect((await send("thC", "in chat")).prompt).not.toContain(DIGEST_HEADING);
});

/** `/find` runner over a space with two channels plus another space. */
function findHarness() {
  const env = makeEnv();
  addLocation(env.home, "location", {}, { channels: [TEST_CHANNEL, "300000000000000003"] });
  addLocation(env.home, "api", {}, { workspace: "w2", channels: [CHANNEL_2] });
  const run = createFindRunner({ db: env.db, agentHome: env.home });
  const ask = (text: string, channelId = TEST_CHANNEL) => run({ channelId, text });
  return { env, ask, run };
}

test("/find lists matching threads of the space (all its channels), newest first, scope = space", async () => {
  const { env, ask } = findHarness();
  titled(env.db, "t1", TEST_CHANNEL, "Invoice export", Date.UTC(2026, 9, 10, 12));
  titled(env.db, "t2", "300000000000000003", "Invoice import", Date.UTC(2026, 9, 12, 12));
  titled(env.db, "t3", CHANNEL_2, "Invoice of another space", Date.UTC(2026, 9, 13, 12));
  const reply = await ask("/find invoice");
  expect(reply?.split("\n")).toEqual([
    expect.stringMatching(/^<#t2> \d\d-\d\d Invoice import$/),
    expect.stringMatching(/^<#t1> \d\d-\d\d Invoice export$/),
  ]);
  expect(await ask("/FIND INVOICE export")).toMatch(/^<#t1> /); // command name is case-insensitive
  expect(await ask("find: INVOICE export")).toBeNull(); // only the slash form is a command: a plain message
  expect(await ask("Find: why the parser fails")).toBeNull();
  expect(await ask("/find nothing-here")).toBe(FIND_NONE);
  expect(await ask("/find")).toBe(FIND_USAGE);
  expect(await ask("/find 100%")).toBe(FIND_NONE); // `%` is literal
  // not a find command: null = a normal task)
  expect(await ask("what does the find command do?")).toBeNull();
});

test("find handler: another space's rows (same channel id) never leak into the results", async () => {
  const { env, ask } = findHarness();
  saveTitle(env.db, "t1", "Invoice mine", "", Date.now(), TEST_CHANNEL, "main");
  saveTitle(env.db, "t2", "Invoice moved", "", Date.now(), TEST_CHANNEL, "w2");
  expect(await ask("/find invoice")).toMatch(/^<#t1> .*$/);
  expect((await ask("/find invoice"))?.split("\n")).toHaveLength(1);
});

test("find: the native slash text (`slashText`) reaches the handler as `/find <keywords>`", async () => {
  const { env, ask } = findHarness();
  titled(env.db, "t1", TEST_CHANNEL, "Hóa đơn", Date.now());
  const text = slashText("find", () => "hóa");
  expect(text).toBe("/find hóa");
  expect(await ask(text ?? "")).toMatch(/^<#t1> /);
});
