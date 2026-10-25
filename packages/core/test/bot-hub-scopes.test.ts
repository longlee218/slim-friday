import { expect, test } from "bun:test";
import { type Bot, CORE_DEFAULTS, type IdleClose, type WakeRow } from "../src";
import type { BotHubDeps } from "../src/hub/bot-hub";
import { flush, makeHub } from "./bot-hub-harness";
import type { FakeSession } from "./fakes/fake-runtime";

/** The harness hub where editor has its own workspace and group "g" has another. */
function scoped(extra: Partial<BotHubDeps> = {}) {
  const h = makeHub(undefined, extra);
  const editor = h.store.botMap.get("editor") as Bot;
  h.store.botMap.set("editor", { ...editor, workspaces: ["/own"] });
  const group = h.store.groupMap.get("g");
  if (group) h.store.groupMap.set("g", { ...group, workspaces: ["/proj"] });
  return h;
}

/** A wake row as an earlier run left it. */
const row = (id: string, over: Partial<WakeRow> = {}): WakeRow => ({
  id,
  chainId: id,
  conversationId: "gc",
  targetBot: "editor",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: `text ${id}`,
  status: "queued",
  attempts: 1,
  createdAt: 0,
  scopeKey: "s",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  nudges: 0,
  ...over,
});

/** Open editor's group session (gc) and direct session (dc); returns them in that order. */
async function openBoth(h: ReturnType<typeof scoped>): Promise<[FakeSession, FakeSession]> {
  h.surface.deliver({ conversationId: "gc", text: "@editor check the draft" });
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  return [h.runtime.nth(0), h.runtime.nth(1)];
}

test("a group message and a direct message open two sessions with their own scope", async () => {
  const h = scoped();
  const [group, direct] = await openBoth(h);
  expect(h.runtime.opened).toHaveLength(2);
  expect(group.spec).toMatchObject({ sessionKey: "editor@g", groupId: "g" });
  expect(group.spec.bot.workspaces).toEqual(["/proj"]);
  expect(direct.spec.sessionKey).toBe("editor");
  expect(direct.spec.groupId).toBeUndefined();
  expect(direct.spec.bot.workspaces).toEqual(["/own"]);
  expect((await h.hub.status()).map((s) => s.groupId)).toEqual(["g", undefined]);
});

test("both sessions are busy at once and each answer posts in its own conversation", async () => {
  const h = scoped();
  const [group, direct] = await openBoth(h);
  expect((await h.hub.status()).every((s) => s.busy)).toBe(true);
  direct.emit({ type: "text", text: "direct answer" });
  group.emit({ type: "text", text: "group answer" });
  direct.emit({ type: "turn_end", costUsd: 0 });
  group.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  const posted = h.surface.posts.map((p) => `${p.conversationId}:${p.message.text}`);
  expect(posted).toContain("dc:direct answer");
  expect(posted).toContain("gc:group answer");
});

test("stop(bot, 'direct') closes only the direct session; stop(bot) closes all", async () => {
  const h = scoped();
  const [group, direct] = await openBoth(h);
  await h.hub.stop("editor", "direct");
  expect(direct.stopped).toBe(true);
  expect(group.stopped).toBe(false);
  await h.hub.stop("editor");
  expect(group.stopped).toBe(true);
  expect(await h.hub.status()).toEqual([]);
});

test("stopGroup closes the group sessions of every member, not their direct ones", async () => {
  const h = scoped();
  const [group, direct] = await openBoth(h);
  h.surface.deliver({ conversationId: "gc", text: "@writer go" });
  await flush();
  const writer = h.runtime.nth(2);
  await h.hub.stopGroup("g");
  expect(group.stopped && writer.stopped).toBe(true);
  expect(direct.stopped).toBe(false);
  expect((await h.hub.status()).map((s) => s.botId)).toEqual(["editor"]);
});

test("send by session key reaches a group member; an unknown key is refused", async () => {
  const h = scoped();
  await openBoth(h);
  const ok = await h.hub.send("editor@g", { to: "writer", text: "your turn", intent: "request" });
  expect(ok.ok).toBe(true);
  await flush();
  expect(h.runtime.nth(2).spec.sessionKey).toBe("writer@g");
  const bad = await h.hub.send("ghost", { to: "writer", text: "x", intent: "request" });
  expect(bad.ok).toBe(false);
});

test("recover() puts a queued group wake into the bot's group session", async () => {
  const h = scoped();
  await h.store.wakes.insert(row("w1"));
  await h.hub.recover();
  await flush();
  expect(h.runtime.nth(0).spec.sessionKey).toBe("editor@g");
  expect(h.runtime.nth(0).sent[0]?.text).toBe("text w1");
});

test("a stored session id of the direct scope is not used for the group scope", async () => {
  const h = scoped();
  await h.store.sessions.set("editor", "old-direct");
  h.surface.deliver({ conversationId: "gc", text: "@editor hi" });
  await flush();
  expect(h.runtime.resumed).toEqual([]);
  expect(await h.store.sessions.get("editor@g")).toBe(h.runtime.nth(0).id);
});

test("sweepIdle closes the idle direct session and keeps the busy group one", async () => {
  const seen: IdleClose[] = [];
  const h = scoped({ onIdleClose: (e) => void seen.push(e) });
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  // A run takes time: it ends after it started.
  h.clock.advance(10);
  h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  h.clock.advance(CORE_DEFAULTS.idleCloseMs);
  h.surface.deliver({ conversationId: "gc", text: "@editor busy work" });
  await flush();
  await h.hub.sweepIdle();
  expect(h.runtime.nth(0).stopped).toBe(true);
  expect(h.runtime.nth(1).stopped).toBe(false);
  expect(seen).toEqual([{ botId: "editor", key: "editor", conversationIds: ["dc"], since: 0 }]);
});

test("the idle-close event of a group session carries its key and group", async () => {
  const seen: IdleClose[] = [];
  const h = scoped({ onIdleClose: (e) => void seen.push(e) });
  h.surface.deliver({ conversationId: "gc", text: "@editor hi" });
  await flush();
  // A run takes time: it ends after it started.
  h.clock.advance(10);
  h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  h.clock.advance(CORE_DEFAULTS.idleCloseMs);
  await h.hub.sweepIdle();
  expect(seen[0]).toMatchObject({ botId: "editor", key: "editor@g", groupId: "g" });
});

test("a recovered wake for a missing group or a non-member is dropped without a session", async () => {
  const h = scoped();
  await h.store.wakes.insert(row("w1"));
  h.store.convMap.set("other", { id: "other", kind: "group", groupId: "nogroup" });
  await h.store.wakes.insert(row("w2", { conversationId: "other" }));
  const group = h.store.groupMap.get("g");
  if (group) h.store.groupMap.set("g", { ...group, members: ["writer"] });
  await h.hub.recover();
  await flush();
  expect(h.runtime.all()).toEqual([]);
  expect((await h.store.wakes.get("w1"))?.status).toBe("dropped");
  expect((await h.store.wakes.get("w2"))?.status).toBe("dropped");
});

test("stop while the session is still opening leaves no registered session", async () => {
  const h = scoped();
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const open = h.runtime.open.bind(h.runtime);
  h.runtime.open = async (spec) => {
    await gate;
    return open(spec);
  };
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const stopping = h.hub.stop("editor");
  release();
  await stopping;
  await flush();
  expect(await h.hub.status()).toEqual([]);
  expect(h.runtime.nth(0).stopped).toBe(true);
});

test("scopeBot shapes the bot of each scope", async () => {
  const h = scoped({
    scopeBot: (b, groupId) => ({ ...b, instructions: `in ${groupId ?? "direct"}` }),
  });
  const [group, direct] = await openBoth(h);
  expect(group.spec.bot.instructions).toBe("in g");
  expect(direct.spec.bot.instructions).toBe("in direct");
});
