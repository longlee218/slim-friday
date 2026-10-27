import { expect, test } from "bun:test";
import { type Bot, CORE_DEFAULTS, type IdleClose, type Ticket, type WakeRow } from "../src";
import type { BotHubDeps } from "../src/hub/bot-hub";
import { flush, makeHub } from "./bot-hub-harness";

/** The harness hub where editor has its own workspace and group "g" has another. */
function scoped(extra: Partial<BotHubDeps> = {}) {
  const h = makeHub(undefined, extra);
  const editor = h.store.botMap.get("editor") as Bot;
  h.store.botMap.set("editor", { ...editor, workspaces: ["/own"] });
  const group = h.store.groupMap.get("g");
  if (group) h.store.groupMap.set("g", { ...group, workspaces: ["/proj"] });
  return h;
}

/** A ticket the writer made in group "g" (or as a direct ticket) for the editor; wakes the editor. */
async function assigned(h: ReturnType<typeof scoped>, groupId: string | null = "g") {
  const r = await h.hub.tickets.create(
    { kind: "bot", botId: "writer" },
    { title: "Fix the build", assigneeBotId: "editor", ...(groupId && { groupId }) },
  );
  if (!r.ok) throw new Error(r.error);
  await flush();
  return r.ticket;
}

/** A queued ticket wake row as an earlier build stored it (scope not placed yet). */
const row = (id: string, ticketId: string): WakeRow => ({
  id,
  chainId: id,
  conversationId: "dc",
  targetBot: "editor",
  sender: { kind: "system" },
  intent: "request",
  hop: 0,
  text: `text ${id}`,
  status: "queued",
  attempts: 1,
  createdAt: 0,
  scopeKey: "s",
  priority: "background",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  nudges: 0,
  ticketId,
});

test("a group ticket wake runs in the ticket scope with the group's grants and posts to the DM", async () => {
  const h = scoped();
  const t = await assigned(h);
  const wake = [...h.store.wakeMap.values()].find((w) => w.ticketId === t.id);
  expect(wake?.scopeKey).toBe("editor#ticket@g");
  const s = h.runtime.nth(0);
  // groupId on the spec: a ticket created inside this run keeps the group (TicketsContext.groupId).
  expect(s.spec).toMatchObject({ sessionKey: "editor#ticket@g", groupId: "g" });
  expect(s.spec.bot.workspaces).toEqual(["/proj"]);
  expect(s.sent[0]).toMatchObject({ conversationId: "dc", context: [] });
  s.emit({ type: "text", text: "on it" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(h.surface.posts.map((p) => `${p.conversationId}:${p.message.text}`)).toContain("dc:on it");
  expect((await h.hub.status()).map((x) => x.groupId)).toEqual(["g"]);
});

test("a direct ticket keeps the direct scope", async () => {
  const h = scoped();
  await assigned(h, null);
  expect(h.runtime.nth(0).spec.sessionKey).toBe("editor");
  expect(h.runtime.nth(0).spec.groupId).toBeUndefined();
  expect(h.runtime.nth(0).spec.bot.workspaces).toEqual(["/own"]);
});

test("placeInScope stores the ticket scope key on a recovered group ticket wake", async () => {
  const h = scoped();
  const t = (await h.store.tickets.create({
    title: "x",
    status: "todo",
    priority: "normal",
    assigneeBotId: "editor",
    groupId: "g",
    createdBy: { kind: "user" },
    createdAt: 1,
  })) as Ticket;
  await h.store.wakes.insert(row("w1", t.id));
  await h.hub.recover();
  await flush();
  expect((await h.store.wakes.get("w1"))?.scopeKey).toBe("editor#ticket@g");
  expect(h.runtime.nth(0).spec.sessionKey).toBe("editor#ticket@g");
});

test("a wake for a deleted ticket keeps the direct scope", async () => {
  const h = scoped();
  await h.store.wakes.insert(row("w1", "gone"));
  await h.hub.recover();
  await flush();
  expect((await h.store.wakes.get("w1"))?.scopeKey).toBe("editor");
  expect(h.runtime.nth(0).spec.sessionKey).toBe("editor");
});

test("a group ticket of a bot no longer in the group is dropped without a session", async () => {
  const h = scoped();
  const t = (await h.store.tickets.create({
    title: "x",
    status: "todo",
    priority: "normal",
    assigneeBotId: "editor",
    groupId: "g",
    createdBy: { kind: "user" },
    createdAt: 1,
  })) as Ticket;
  const group = h.store.groupMap.get("g");
  if (group) h.store.groupMap.set("g", { ...group, members: ["writer"] });
  await h.hub.wakeForTicket(t, "editor");
  await flush();
  expect(h.runtime.all()).toEqual([]);
  expect([...h.store.wakeMap.values()].map((w) => w.status)).toEqual(["dropped"]);
});

test("Stop in the DM cancels the bot's ticket-scope runs; stop for the group chat does not", async () => {
  const h = scoped();
  await assigned(h);
  expect(await h.hub.stop("editor", "g")).toBe(0);
  expect(h.runtime.nth(0).stopped).toBe(false);
  expect(await h.hub.stop("editor", "direct")).toBe(1);
  expect(h.runtime.nth(0).stopped).toBe(true);
});

test("the group channel's Stop leaves ticket runs; removing the group cancels them", async () => {
  const h = scoped();
  await assigned(h);
  expect(await h.hub.stopGroup("g")).toBe(0);
  expect(h.runtime.nth(0).stopped).toBe(false);
  await h.hub.configChanged({ removedBots: [], removedGroups: ["g"], resetScopes: [] });
  expect(h.runtime.nth(0).stopped).toBe(true);
  expect([...h.store.wakeMap.values()].map((w) => w.status)).toEqual(["cancelled"]);
});

test("the idle close of a ticket scope names the bot and its DM, not the group", async () => {
  const seen: IdleClose[] = [];
  const h = scoped({ onIdleClose: (e) => void seen.push(e) });
  const t = await assigned(h);
  await h.hub.tickets.update({ kind: "bot", botId: "editor" }, { id: t.id, status: "done" });
  h.clock.advance(10);
  h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  h.clock.advance(CORE_DEFAULTS.idleCloseMs);
  await h.hub.sweepIdle();
  const ticketClose = seen.find((e) => e.key === "editor#ticket@g");
  expect(ticketClose).toEqual({
    botId: "editor",
    key: "editor#ticket@g",
    conversationIds: ["dc"],
    since: 0,
  });
});
