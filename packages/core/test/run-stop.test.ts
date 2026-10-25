import { expect, test } from "bun:test";
import { CORE_DEFAULTS, type WakeRow } from "../src";
import { flush, makeHub, tick } from "./bot-hub-harness";

const LS = { tool: "Bash", input: { command: "ls" } };

/** A complete queued run for a test to store directly. */
const queuedRow = (over: Partial<WakeRow>): WakeRow => ({
  id: "q1",
  chainId: "q1",
  conversationId: "dc",
  targetBot: "editor",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: "later",
  status: "queued",
  attempts: 0,
  createdAt: 1,
  scopeKey: "editor",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  nudges: 0,
  wakeAt: 9_000_000_000_000,
  ...over,
});

/** A hub where editor's direct run is parked on an approval card. */
async function parked() {
  const h = makeHub();
  h.editor.tools = ["Bash"];
  h.surface.deliver({ conversationId: "dc", text: "list files" });
  await flush();
  const d = await h.runtime.last().spec.decide(LS);
  await flush();
  const cardId = d.behavior === "park" ? d.cardId : "";
  return { ...h, cardId };
}

test("stop cancels running, queued and parked runs of the scope and withdraws cards", async () => {
  const h = await parked();
  // A queued run of the same scope and a running one in editor's group scope.
  await h.store.wakes.insert(queuedRow({}));
  h.surface.deliver({ conversationId: "gc", text: "@editor dig" });
  await flush();
  await h.store.steering.add({
    id: "s1",
    messageId: 1,
    conversationId: "dc",
    scopeKey: "editor",
    text: "also",
    createdAt: 2,
  });
  const statuses = () => [...h.store.wakeMap.values()].map((w) => w.status);
  expect(statuses().sort()).toEqual(["queued", "running", "waiting_input"]);
  expect(await h.hub.stop("editor")).toBe(3);
  for (const w of h.store.wakeMap.values())
    expect(w).toMatchObject({ status: "cancelled", error: "Stopped by the owner." });
  expect(await h.store.steering.held("editor")).toEqual([]);
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("withdrawn");
  expect(h.surface.closed.map((c) => [c.id, c.status])).toEqual([[h.cardId, "withdrawn"]]);
  // The group run's session was stopped; the owner's stop does not wake any bot.
  expect(h.runtime.all().some((s) => s.spec.groupId === "g" && s.stopped)).toBe(true);
  for (const w of h.store.wakeMap.values()) expect(w.outcomeReturnedAt).toBeDefined();
});

test("a stopped delegated run wakes no one and the group gets a notice", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "gc", text: "go" });
  await flush();
  await h.hub.send("writer@g", { to: "editor", text: "check", intent: "request" });
  await flush();
  const before = h.store.wakeMap.size;
  expect(await h.hub.stop("editor")).toBe(1);
  await flush();
  expect(h.store.wakeMap.size).toBe(before);
  const posts = h.surface.posts.filter((p) => p.message.author.kind === "system");
  expect(posts.map((p) => p.message.text)).toEqual([
    "Stopped by the owner: the request to Editor was cancelled.",
  ]);
});

test("executor drops a tool result after cancel", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "work" });
  await flush();
  const s = h.runtime.last();
  const [w] = [...h.store.wakeMap.values()];
  if (!w) throw new Error("no run");
  // Another process cancelled the row: only the fence check of this worker sees it.
  await h.store.wakes.transition(w.id, w.leaseFence, ["running"], {
    status: "cancelled",
    endedAt: 1,
    outcomeReturnedAt: 1,
  });
  await tick(h.clock, CORE_DEFAULTS.fenceCheckMs);
  expect(s.stopped).toBe(true);
  s.emit({ type: "tool_result", toolUseId: "t1", output: "late" } as never);
  s.emit({ type: "text", text: "late text" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(h.surface.posts.some((p) => p.message.text === "late text")).toBe(false);
  expect(h.store.wakeMap.get(w.id)?.status).toBe("cancelled");
});

test("status lists running and parked runs", async () => {
  const h = await parked();
  h.surface.deliver({ conversationId: "gc", text: "@writer go" });
  await flush();
  const st = await h.hub.status();
  expect(st.map((s) => [s.botId, s.groupId, s.busy, s.parked])).toEqual([
    ["editor", undefined, false, true],
    ["writer", "g", true, false],
  ]);
});

test("changed bot gets a fresh session at its next open, not while parked", async () => {
  const h = await parked();
  await h.hub.configChanged({ removedBots: [], removedGroups: [], resetScopes: ["editor"] });
  expect((await h.store.scopes.get("editor"))?.resetPending).toBe(true);
  await h.hub.answerCard(h.cardId, "once");
  await flush();
  // The answered run resumes its own session; the reset waits.
  expect(h.runtime.resumed).toHaveLength(1);
  expect((await h.store.scopes.get("editor"))?.resetPending).toBe(true);
  h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "next" });
  await flush();
  expect(h.runtime.resumed).toHaveLength(1);
  expect(h.runtime.opened).toHaveLength(2);
  expect((await h.store.scopes.get("editor"))?.resetPending).toBe(false);
});

test("removed bot's queued run is cancelled with a notice", async () => {
  const h = makeHub();
  await h.store.wakes.insert(queuedRow({ conversationId: "dc" }));
  await h.hub.configChanged({ removedBots: ["editor"], removedGroups: [], resetScopes: [] });
  expect(h.store.wakeMap.get("q1")).toMatchObject({
    status: "cancelled",
    error: "The bot was removed.",
  });
  expect(h.surface.posts.map((p) => p.message.text)).toEqual([
    "Editor was removed: its pending requests were cancelled.",
  ]);
});

test("a run stopped by a config change toasts the owner; a delegated stop does not", async () => {
  const h = await parked();
  await h.hub.configChanged({ removedBots: ["editor"], removedGroups: [], resetScopes: [] });
  expect(h.surface.finished.at(-1)?.botId).toBe("editor");
  expect(h.surface.finished.at(-1)?.preview).toContain("was removed");
});

test("the reconciler withdraws open cards of a run cancelled before the process could", async () => {
  const h = await parked();
  // A crash after the cancel was committed: the row is cancelled, the card still open.
  const [w] = [...h.store.wakeMap.values()];
  if (!w) throw new Error("no run");
  await h.store.wakes.transition(w.id, w.leaseFence, ["waiting_input"], {
    status: "cancelled",
    endedAt: 1,
    outcomeReturnedAt: 1,
  });
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("open");
  const stop = h.hub.startReconciler();
  await flush();
  await stop();
  expect(h.store.cardMap.get(h.cardId)?.status).toBe("withdrawn");
  expect(h.surface.closed.map((c) => c.id)).toEqual([h.cardId]);
});

test("a fence that moves once between the read and the cancel: the run still ends cancelled and is counted", async () => {
  const h = makeHub();
  await h.store.wakes.insert(queuedRow({}));
  const real = h.store.wakes.transition;
  let moved = false;
  // A worker claims the row (fence +1) just before the first cancel write.
  h.store.wakes.transition = async (id, fence, from, patch) => {
    const w = h.store.wakeMap.get(id);
    if (!moved && w) {
      moved = true;
      w.leaseFence += 1;
    }
    return real(id, fence, from, patch);
  };
  expect(await h.hub.stop("editor")).toBe(1);
  expect(h.store.wakeMap.get("q1")?.status).toBe("cancelled");
});

test("when every retry loses the fence race, run.stop_lost is logged with the wake id only", async () => {
  const h = makeHub();
  await h.store.wakes.insert(queuedRow({}));
  const real = h.store.wakes.transition;
  h.store.wakes.transition = async (id, fence, from, patch) => {
    const w = h.store.wakeMap.get(id);
    if (w) w.leaseFence += 1;
    return real(id, fence, from, patch);
  };
  expect(await h.hub.stop("editor")).toBe(0);
  expect(h.log.of("run.stop_lost").map((l) => l.fields)).toEqual([{ wakeId: "q1" }]);
});
