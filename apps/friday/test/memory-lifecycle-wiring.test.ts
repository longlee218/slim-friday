import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRuntimeSpec, ConsolidateFn, MemoryOwner } from "@friday/core";
import { localDay } from "@friday/tools";
import { FakeRuntime } from "../../../packages/core/test/fakes/fake-runtime";
import { createMessageSearchTool } from "../../../packages/tools/src/memory/tools/MessageSearchTool/message-search-tool";
import { idleFlush } from "../src/idle-flush";
import { toolContext } from "../src/session-tools";
import { type AppDeps, type RuntimeParts, startApp } from "../src/start-app";
import { webParts } from "./web-fixture";

const friday: MemoryOwner = { kind: "bot", botId: "friday" };
const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stoppers.splice(0)) await s();
});

/** Start the app over fakes on `home`; hand back the app and the parts the runtime factory received. */
async function boot(home: string, extra: Partial<AppDeps> = {}) {
  let parts: RuntimeParts | undefined;
  const app = await startApp({
    ...webParts(home),
    runtime: (p) => {
      parts = p;
      return new FakeRuntime();
    },
    agentHome: home,
    log: { info() {}, warn() {}, error() {} },
    ...extra,
  });
  stoppers.push(() => app.stop());
  if (!parts) throw new Error("runtime factory not called");
  await app.memoryReady;
  return { app, parts };
}

/** Friday's direct conversation id (made by the first channel sync). */
async function fridayChat(parts: RuntimeParts): Promise<string> {
  const c = await parts.store.conversations.direct("friday");
  if (!c) throw new Error("no direct conversation");
  return c.id;
}

const say = (parts: RuntimeParts, conversationId: string, text: string, at = Date.now()) =>
  parts.store.messages.append({ conversationId, author: { kind: "user" }, text, at });

test("MessageSearch through session tools finds a message sent in the bot's channel", async () => {
  const { parts } = await boot(mkdtempSync(join(tmpdir(), "life-")));
  await say(parts, await fridayChat(parts), "the release goes out on thursday");
  const spec = {
    bot: { id: "friday" },
    currentConversation: () => undefined,
  } as unknown as BotRuntimeSpec;
  const t = createMessageSearchTool(parts.messages, toolContext(spec, parts.store));
  const r = (await t.handler({ query: "thursday release" } as never, {})) as {
    content: { text: string }[];
  };
  expect(r.content[0]?.text).toContain("the release goes out on thursday");
});

test("idle close with 2+ messages writes an Idle flush block and it is searchable", async () => {
  const home = mkdtempSync(join(tmpdir(), "life-"));
  const { parts } = await boot(home);
  const c = await fridayChat(parts);
  await say(parts, c, "we pick postgres for the ledger");
  await say(parts, c, "and redis for the queue");
  const seen: string[] = [];
  await idleFlush({
    store: parts.store,
    memoryRoot: join(home, "memory"),
    flushNotes: async (t) => {
      seen.push(t);
      return ["ledger uses postgres"];
    },
    memoryChanged: parts.memoryChanged,
    log: { error() {}, warn() {} },
  })({ botId: "friday", key: "friday", conversationIds: [c], since: 0 });
  expect(seen[0]).toContain("user: we pick postgres for the ledger\nuser: and redis for the queue");
  const hits = await parts.recall.search(friday, "ledger postgres");
  expect(hits.map((h) => h.where)).toEqual([localDay(new Date())]);
});

test("idle close with one message calls no flushNotes", async () => {
  const home = mkdtempSync(join(tmpdir(), "life-"));
  const { parts } = await boot(home);
  const c = await fridayChat(parts);
  // The channel's greeting is stored at boot, so "since" falls after it.
  const since = Date.now() + 5;
  await say(parts, c, "hello", since + 5);
  await say(parts, c, "old one", 1);
  let called = false;
  await idleFlush({
    store: parts.store,
    memoryRoot: join(home, "memory"),
    flushNotes: async () => {
      called = true;
      return [];
    },
    memoryChanged: parts.memoryChanged,
    log: { error() {}, warn() {} },
  })({ botId: "friday", key: "friday", conversationIds: [c], since });
  expect(called).toBe(false);
});

test("daily run promotes a journal note into MEMORY.md and the index finds it under [memory]", async () => {
  const home = mkdtempSync(join(tmpdir(), "life-"));
  const day = localDay(new Date(Date.now() - 3 * 86_400_000));
  const dir = join(home, "memory", "bots", "friday", "journal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${day}.md`),
    `# Journal ${day}\n\n## 09:00 Flush\n- owner ships on fridays\n`,
  );
  const consolidate: ConsolidateFn = async (_m, notes) =>
    notes.map((note) => ({ kind: "fact", note }));
  const { parts } = await boot(home, { consolidate });
  const hits = await parts.recall.search(friday, "ships fridays");
  expect(hits.map((h) => h.where)).toContain("memory");
});

test("stop() does not wait for a consolidation call that never answers", async () => {
  const home = mkdtempSync(join(tmpdir(), "life-"));
  const day = localDay(new Date(Date.now() - 3 * 86_400_000));
  const dir = join(home, "memory", "bots", "friday", "journal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.md`), `# Journal ${day}\n\n## 09:00 Flush\n- a note\n`);
  const app = await startApp({
    ...webParts(home),
    runtime: () => new FakeRuntime(),
    agentHome: home,
    log: { info() {}, warn() {}, error() {} },
    consolidate: () => new Promise(() => {}),
  });
  const r = await Promise.race([
    app.stop().then(() => "stopped"),
    Bun.sleep(2000).then(() => "hung"),
  ]);
  expect(r).toBe("stopped");
});

test("idle flush logs a full journal day instead of dropping the notes silently", async () => {
  const home = mkdtempSync(join(tmpdir(), "life-"));
  const { parts } = await boot(home);
  const c = await fridayChat(parts);
  await say(parts, c, "we pick postgres for the ledger");
  await say(parts, c, "and redis for the queue");
  const dir = join(home, "memory", "bots", "friday", "journal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${localDay(new Date())}.md`), "- x\n".repeat(300));
  const warns: string[] = [];
  await idleFlush({
    store: parts.store,
    memoryRoot: join(home, "memory"),
    flushNotes: async () => ["ledger uses postgres", `${"word ".repeat(70)}end`],
    memoryChanged: parts.memoryChanged,
    log: { error() {}, warn: (_o: object, msg: string) => void warns.push(msg) },
  })({ botId: "friday", key: "friday", conversationIds: [c], since: 0 });
  expect(warns).toEqual(["memory.journal_full"]);
});

test("idle close of a group session writes into the group's journal", async () => {
  const home = mkdtempSync(join(tmpdir(), "life-"));
  const { parts } = await boot(home);
  const c = await fridayChat(parts);
  await say(parts, c, "we pick postgres for the ledger");
  await say(parts, c, "and redis for the queue");
  const changed: MemoryOwner[] = [];
  await idleFlush({
    store: parts.store,
    memoryRoot: join(home, "memory"),
    flushNotes: async () => ["team ledger uses postgres"],
    memoryChanged: (o) => void changed.push(o),
    log: { error() {}, warn() {} },
  })({ botId: "friday", key: "friday@team", groupId: "team", conversationIds: [c], since: 0 });
  expect(changed).toEqual([{ kind: "group", groupId: "team" }]);
  expect(existsSync(join(home, "memory", "groups", "team", "journal"))).toBe(true);
});
