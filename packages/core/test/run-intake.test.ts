import { expect, test } from "bun:test";
import { type CardRow, CORE_DEFAULTS, type CoreLimits, type WakeRow } from "../src";
import type { HubContext } from "../src/hub/hub-context";
import { createRun } from "../src/runs/run-create";
import { InProcessHints, type RunHint } from "../src/runs/run-hints";
import { makeHub } from "./bot-hub-harness";

/** A hub whose hints are recorded. */
function setup(limits: CoreLimits = CORE_DEFAULTS) {
  const hints = new InProcessHints();
  const seen: RunHint[] = [];
  hints.on((h) => seen.push(h));
  const h = makeHub(undefined, { hints, limits });
  // The hub's shared context, so a test can create a bot run the way a worker would.
  const ctx = (h.hub as unknown as { ctx: HubContext }).ctx;
  return { ...h, hints, seen, ctx };
}

const runs = (rows: Map<string, WakeRow>) => [...rows.values()];

/** A stored run in a scope, as a worker would have left it. */
function storedRun(p: Partial<WakeRow> & Pick<WakeRow, "id" | "scopeKey" | "status">): WakeRow {
  return {
    chainId: p.id,
    conversationId: "dc",
    targetBot: "editor",
    sender: { kind: "user" },
    intent: "request",
    hop: 0,
    text: "earlier",
    attempts: 1,
    createdAt: 0,
    priority: "interactive",
    leaseFence: 1,
    cuts: 0,
    transientRetries: 0,
    setupFailures: 0,
    nudges: 0,
    ...p,
  };
}

/** An open card of the editor's direct scope, waiting on run `wakeId`. */
function openCard(id: string, wakeId: string, kind: CardRow["kind"], allowText = true): CardRow {
  return {
    id,
    kind,
    wakeId,
    botId: "editor",
    conversationId: "dc",
    scopeKey: "editor",
    ...(kind === "question"
      ? {
          question: {
            botId: "editor",
            botName: "Editor",
            question: "Which one?",
            kind: "single",
            options: [],
            allowText,
          },
        }
      : {
          approval: {
            tool: "Bash",
            input: { command: "ls" },
            inputHash: "h",
            summary: "ls",
            scope: {},
            offerAlways: false,
          },
        }),
    status: "open",
    createdAt: 0,
  };
}

test("idle scope gets a queued run and a hint", async () => {
  const { hub, store, seen, runtime } = setup();
  await hub.handle({ conversationId: "dc", text: "hi" });
  const all = runs(store.wakeMap);
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({
    status: "queued",
    scopeKey: "editor",
    priority: "interactive",
    text: "hi",
    sender: { kind: "user" },
  });
  expect(seen).toEqual([{ kind: "newRun", wakeId: all[0]?.id ?? "" }]);
  // Nothing runs in the main process: a worker claims the run.
  expect(runtime.opened).toHaveLength(0);
});

test("burst of three owner messages: one run, two steering rows", async () => {
  const { hub, store, seen } = setup();
  for (const text of ["one", "two", "three"]) await hub.handle({ conversationId: "dc", text });
  const all = runs(store.wakeMap);
  expect(all).toHaveLength(1);
  const id = all[0]?.id ?? "";
  const rows = [...store.steerMap.values()];
  expect(rows.map((r) => [r.text, r.wakeId, r.scopeKey])).toEqual([
    ["two", id, "editor"],
    ["three", id, "editor"],
  ]);
  expect(seen.map((h) => h.kind)).toEqual(["newRun", "steer", "steer"]);
});

test("owner message to a busy scope of another conversation is a new queued run", async () => {
  const { hub, store } = setup();
  await store.wakes.insert(
    storedRun({ id: "busy", scopeKey: "editor", status: "running", conversationId: "other" }),
  );
  await hub.handle({ conversationId: "dc", text: "hi" });
  const fresh = runs(store.wakeMap).filter((w) => w.id !== "busy");
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatchObject({ status: "queued", conversationId: "dc", scopeKey: "editor" });
  expect(store.steerMap.size).toBe(0);
});

test("bot message to a busy scope is a queued run, never steering", async () => {
  const { hub, store, ctx, seen } = setup();
  await hub.handle({ conversationId: "gc", text: "hi" });
  const outcome = await createRun(ctx, {
    botId: "writer",
    conversationId: "gc",
    sender: { kind: "bot", botId: "editor" },
    text: "please check",
    hop: 1,
  });
  expect(outcome.ok).toBe(true);
  const writerRuns = runs(store.wakeMap).filter((w) => w.scopeKey === "writer@g");
  expect(writerRuns.map((w) => w.status)).toEqual(["queued", "queued"]);
  expect(store.steerMap.size).toBe(0);
  expect(seen.map((h) => h.kind)).toEqual(["newRun", "newRun"]);
});

test("typed text answers an open question card and requeues its run", async () => {
  const { hub, store, seen } = setup();
  await store.wakes.insert(storedRun({ id: "asker", scopeKey: "editor", status: "waiting_input" }));
  await store.cards.insert(openCard("q1", "asker", "question"));
  await hub.handle({ conversationId: "dc", text: "the blue one" });
  expect(store.cardMap.get("q1")).toMatchObject({
    status: "answered",
    answer: { choices: [], text: "the blue one" },
  });
  expect(store.wakeMap.get("asker")?.status).toBe("queued");
  expect(store.wakeMap.size).toBe(1);
  expect(store.steerMap.size).toBe(0);
  expect(seen).toEqual([{ kind: "cardAnswered", cardId: "q1" }]);
});

test("open approval card: message becomes a new run, card stays open", async () => {
  const { hub, store } = setup();
  await store.wakes.insert(storedRun({ id: "asker", scopeKey: "editor", status: "waiting_input" }));
  await store.cards.insert(openCard("a1", "asker", "approval"));
  await hub.handle({ conversationId: "dc", text: "meanwhile, this" });
  expect(store.cardMap.get("a1")?.status).toBe("open");
  expect(store.wakeMap.get("asker")?.status).toBe("waiting_input");
  const fresh = runs(store.wakeMap).filter((w) => w.id !== "asker");
  expect(fresh.map((w) => [w.status, w.text])).toEqual([["queued", "meanwhile, this"]]);
});

test("same clientNonce twice stores one message and returns the same id", async () => {
  const { hub, store } = setup();
  const first = await hub.handle({ conversationId: "dc", text: "hi", clientNonce: "n1" });
  const again = await hub.handle({ conversationId: "dc", text: "hi", clientNonce: "n1" });
  expect(first).toBeDefined();
  expect(again).toBe(first);
  expect(await store.messages.recent("dc", 10)).toHaveLength(1);
  expect(store.wakeMap.size).toBe(1);
  expect(store.steerMap.size).toBe(0);
});

test("blocked by rate cap is stored as blocked with a notice", async () => {
  const { ctx, store, surface, seen } = setup({
    ...CORE_DEFAULTS,
    maxBotMessagesPerConversationPerHour: 1,
  } as unknown as CoreLimits);
  const send = (text: string) =>
    createRun(ctx, {
      botId: "writer",
      conversationId: "gc",
      sender: { kind: "bot", botId: "editor" },
      text,
      hop: 1,
    });
  expect((await send("one")).ok).toBe(true);
  expect(await send("two")).toEqual({ ok: false, reason: "rate" });
  const blocked = runs(store.wakeMap).find((w) => w.text === "two");
  expect(blocked).toMatchObject({ status: "blocked", blockReason: "rate" });
  const notices = surface.posts.filter((p) => p.message.author.kind === "system");
  expect(notices.map((p) => p.message.text)).toEqual(["Stopped: rate limit reached."]);
  expect(seen.map((h) => h.kind)).toEqual(["newRun"]);
});

test("two owner messages that race for a free scope end as one run; the older one is superseded", async () => {
  const { hub, store } = setup();
  await Promise.all([
    hub.handle({ conversationId: "dc", text: "one" }),
    hub.handle({ conversationId: "dc", text: "two" }),
  ]);
  const all = runs(store.wakeMap);
  expect(all.filter((w) => w.status === "queued")).toHaveLength(1);
  expect(all.filter((w) => w.status === "cancelled")).toHaveLength(1);
  const live = all.find((w) => w.status === "queued");
  const moved = [...store.steerMap.values()];
  expect(moved).toHaveLength(1);
  expect(moved[0]?.wakeId).toBe(live?.id);
  expect([live?.text, moved[0]?.text].sort()).toEqual(["one", "two"]);
});

test("a resend after a crash between storing and routing routes the message once", async () => {
  const { hub, store } = setup();
  // The crash: the message was stored under its nonce, nothing was routed.
  const msg = { conversationId: "dc", author: { kind: "user" as const }, text: "hi", at: 0 };
  const { id } = await store.messages.appendOnce({ ...msg, kind: "text" }, "n1");
  expect(await hub.handle({ conversationId: "dc", text: "hi", clientNonce: "n1" })).toBe(id);
  expect(await hub.handle({ conversationId: "dc", text: "hi", clientNonce: "n1" })).toBe(id);
  expect(await store.messages.recent("dc", 10)).toHaveLength(1);
  expect(runs(store.wakeMap).map((w) => [w.status, w.text])).toEqual([["queued", "hi"]]);
  expect(store.steerMap.size).toBe(0);
});

test("a resent steering message adds no second row", async () => {
  const { hub, store } = setup();
  await hub.handle({ conversationId: "dc", text: "one" });
  await hub.handle({ conversationId: "dc", text: "two", clientNonce: "n2" });
  await hub.handle({ conversationId: "dc", text: "two", clientNonce: "n2" });
  expect(store.wakeMap.size).toBe(1);
  expect([...store.steerMap.values()].map((r) => r.text)).toEqual(["two"]);
});

test("a resent answer requeues the parked run and starts no new run", async () => {
  const { hub, store } = setup();
  await store.wakes.insert(storedRun({ id: "asker", scopeKey: "editor", status: "waiting_input" }));
  await store.cards.insert(openCard("q1", "asker", "question"));
  await hub.handle({ conversationId: "dc", text: "blue", clientNonce: "n3" });
  // The crash between answering the card and requeuing its run: the run is still parked.
  await store.wakes.update("asker", { status: "waiting_input" });
  await hub.handle({ conversationId: "dc", text: "blue", clientNonce: "n3" });
  expect(store.wakeMap.get("asker")?.status).toBe("queued");
  expect(store.wakeMap.size).toBe(1);
  expect(store.steerMap.size).toBe(0);
  expect(store.cardMap.get("q1")?.answer).toEqual({ choices: [], text: "blue" });
});

test("supersede leaves the copies out when the old run was claimed meanwhile", async () => {
  const { hub, store } = setup();
  // A worker claims the older run between the copy and the cancel.
  const add = store.steering.add;
  store.steering.add = async (r) => {
    await add(r);
    for (const w of store.wakeMap.values())
      if (w.status === "queued" && w.text === "one")
        Object.assign(w, { status: "leased", leaseFence: 1 });
  };
  await Promise.all([
    hub.handle({ conversationId: "dc", text: "one" }),
    hub.handle({ conversationId: "dc", text: "two" }),
  ]);
  expect(runs(store.wakeMap).map((w) => [w.text, w.status])).toEqual([
    ["one", "leased"],
    ["two", "queued"],
  ]);
  expect(store.steerMap.size).toBe(0);
});

test("a steering row whose host run ends meanwhile becomes a new queued run, no orphan row", async () => {
  const { hub, store } = setup();
  await hub.handle({ conversationId: "dc", text: "one" });
  const host = runs(store.wakeMap)[0];
  // The host run finishes between the scope read and the steering write.
  const add = store.steering.add;
  store.steering.add = async (r) => {
    if (host) host.status = "done";
    await add(r);
  };
  await hub.handle({ conversationId: "dc", text: "two" });
  expect(store.steerMap.size).toBe(0);
  const queued = runs(store.wakeMap).filter((w) => w.status === "queued");
  expect(queued.map((w) => w.text)).toEqual(["two"]);
});

test("a held row whose busy bot run ends meanwhile becomes a new queued run", async () => {
  const { hub, store } = setup();
  const busy = storedRun({ id: "bot", scopeKey: "editor", status: "running" });
  await store.wakes.insert({ ...busy, sender: { kind: "bot", botId: "writer" } });
  const add = store.steering.add;
  store.steering.add = async (r) => {
    const w = store.wakeMap.get("bot");
    if (w) w.status = "done";
    await add(r);
  };
  await hub.handle({ conversationId: "dc", text: "meanwhile" });
  expect(store.steerMap.size).toBe(0);
  const queued = runs(store.wakeMap).filter((w) => w.status === "queued");
  expect(queued.map((w) => w.text)).toEqual(["meanwhile"]);
});

test("a run is not claimable between its insert and its cap check", async () => {
  const { hub, store } = setup();
  const claim = () =>
    store.wakes.claimNext({ owner: "b:w", bootId: "b", now: 0, leaseMs: 300_000 });
  const seen: unknown[] = [];
  const total = store.spend.total;
  store.spend.total = async (botId, day) => {
    seen.push(await claim());
    return total(botId, day);
  };
  await hub.handle({ conversationId: "dc", text: "hi" });
  expect(seen).toEqual([undefined]);
  expect((await claim())?.text).toBe("hi");
});

test("steering into queued owner runs binds to the newest one", async () => {
  const { hub, store } = setup();
  await store.wakes.insert(storedRun({ id: "old", scopeKey: "editor", status: "queued" }));
  await store.wakes.insert(
    storedRun({ id: "new", scopeKey: "editor", status: "queued", createdAt: 1 }),
  );
  await hub.handle({ conversationId: "dc", text: "more" });
  expect([...store.steerMap.values()].map((r) => r.wakeId)).toEqual(["new"]);
});
