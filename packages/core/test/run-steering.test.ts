import { expect, test } from "bun:test";
import type { SteeringRow, WakeRow } from "../src";
import type { HubContext } from "../src/hub/hub-context";
import { createRun } from "../src/runs/run-create";
import { CONTINUATION_PROMPT, holdOrContinue } from "../src/runs/run-steering";
import { flush, makeHub, tick } from "./bot-hub-harness";

/** The hub's shared context (a test creates runs the way a worker would). */
const ctxOf = (h: ReturnType<typeof makeHub>) => (h.hub as unknown as { ctx: HubContext }).ctx;
const wakes = (h: ReturnType<typeof makeHub>) => [...h.store.wakeMap.values()];
const HEADER = "New message from the owner while you work:";

/** A run row in editor's direct scope. */
const run = (over: Partial<WakeRow> = {}): WakeRow => ({
  id: "w1",
  chainId: "w1",
  conversationId: "dc",
  targetBot: "editor",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: "first",
  status: "queued",
  attempts: 0,
  createdAt: 0,
  wakeAt: 0,
  scopeKey: "editor",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  nudges: 0,
  ...over,
});

/** A steering row of editor's direct conversation. */
const steer = (id: string, createdAt: number, over: Partial<SteeringRow> = {}): SteeringRow => ({
  id,
  messageId: createdAt,
  conversationId: "dc",
  scopeKey: "editor",
  text: id,
  createdAt,
  ...over,
});

test("rows waiting at claim are pushed with the first turn", async () => {
  const h = makeHub();
  await h.store.wakes.insert(run());
  await h.store.steering.add(steer("two", 1, { wakeId: "w1" }));
  await h.store.steering.add(steer("three", 2, { wakeId: "w1" }));
  await h.hub.recover();
  await flush();
  const turns = h.runtime.turns();
  expect(turns).toHaveLength(1);
  expect(turns[0]?.text).toBe(`first\n\n${HEADER}\ntwo\n\n${HEADER}\nthree`);
  expect(h.runtime.last().steered).toEqual([]);
  h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(wakes(h)[0]?.status).toBe("done");
  expect(h.store.steerMap.size).toBe(0);
  expect(wakes(h)).toHaveLength(1);
});

test("inject mode pushes a row after the next tool result", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "start" });
  await flush();
  const s = h.runtime.last();
  // No tool in flight: the row waits, nothing is pushed into a turn that may be ending.
  h.surface.deliver({ conversationId: "dc", text: "also this" });
  await flush();
  expect(s.steered).toEqual([]);
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Bash", input: {} });
  s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
  await flush();
  expect(s.steered).toEqual([{ text: `${HEADER}\nalso this` }]);
  // A message that comes while a tool is in flight is pushed at once.
  s.emit({ type: "tool_call", toolUseId: "t2", tool: "Bash", input: {} });
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "and that" });
  await flush();
  expect(s.steered.map((x) => x.text)).toEqual([`${HEADER}\nalso this`, `${HEADER}\nand that`]);
  s.emit({ type: "tool_result", toolUseId: "t2", ok: true });
  s.emit({ type: "text", text: "both done" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  // Answered inside the turn: rows deleted, no continuation run.
  expect(h.store.steerMap.size).toBe(0);
  expect(wakes(h)).toHaveLength(1);
  expect(wakes(h)[0]?.status).toBe("done");
});

test("non-conversational run leaves rows held and finish creates one continuation run with CONTINUATION_PROMPT", async () => {
  const h = makeHub();
  await h.store.steering.add(steer("later", 1));
  await createRun(ctxOf(h), {
    botId: "editor",
    conversationId: "dc",
    sender: { kind: "bot", botId: "writer" },
    text: "do it",
    hop: 1,
  });
  await flush();
  const first = h.runtime.last();
  expect(first.steered).toEqual([]);
  expect(first.sent[0]?.text).toBe("do it");
  expect(h.store.steerMap.get("later")?.wakeId).toBeUndefined();
  first.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  const all = wakes(h);
  const cont = all.filter((w) => w.text === CONTINUATION_PROMPT);
  expect(cont).toHaveLength(1);
  expect(all).toHaveLength(2);
  // The continuation run took the row with its first turn.
  expect(h.runtime.last().sent[0]?.text).toBe(`${CONTINUATION_PROMPT}\n\n${HEADER}\nlater`);
  expect(h.store.steerMap.get("later")).toMatchObject({ wakeId: cont[0]?.id });
});

test("cut run: every claimed row (none was deleted as answered) is offered again", async () => {
  const h = makeHub();
  await h.store.wakes.insert(
    run({
      status: "running",
      attempts: 1,
      startedAt: 0,
      leaseOwner: "oldboot:main",
      leaseFence: 1,
      leaseExpiresAt: 300_000,
    }),
  );
  await h.store.steering.add(steer("claimed", 1, { wakeId: "w1", claimedAt: 60 }));
  await h.store.steering.add(steer("fresh", 3, { wakeId: "w1" }));
  await h.hub.recover();
  await flush();
  const text = h.runtime.last().sent[0]?.text ?? "";
  expect(text).toContain(`${HEADER}\nclaimed`);
  expect(text).toContain(`${HEADER}\nfresh`);
});

test("no continuation while another run is queued in the scope", async () => {
  const h = makeHub();
  await h.store.steering.add(steer("later", 1));
  await h.store.wakes.insert(run({ id: "busy", wakeAt: Number.MAX_SAFE_INTEGER }));
  await holdOrContinue(ctxOf(h), "editor");
  expect(wakes(h)).toHaveLength(1);
  expect(h.store.steerMap.get("later")?.wakeId).toBeUndefined();
  await h.store.wakes.transition("busy", 0, ["queued"], { status: "done" });
  await holdOrContinue(ctxOf(h), "editor");
  await holdOrContinue(ctxOf(h), "editor");
  expect(wakes(h).filter((w) => w.text === CONTINUATION_PROMPT)).toHaveLength(1);
});

/** A hub with one held row and a finished bot run, so a continuation run is running. */
async function withContinuation() {
  const h = makeHub();
  await h.store.steering.add(steer("later", 1));
  await createRun(ctxOf(h), {
    botId: "editor",
    conversationId: "dc",
    sender: { kind: "bot", botId: "writer" },
    text: "do it",
    hop: 1,
  });
  await flush();
  h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  return h;
}

test("a failed run hands its rows to a continuation; a failed continuation deletes them", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "start" });
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "more" });
  await flush();
  h.runtime.last().emit({ type: "error", message: "boom", retryable: false });
  await flush();
  const cont = wakes(h).filter((w) => w.text === CONTINUATION_PROMPT);
  expect(wakes(h).map((w) => w.status)).toEqual(["failed", "running"]);
  expect(cont).toHaveLength(1);
  // The continuation fails too: its rows are deleted and no third run starts.
  h.runtime.last().emit({ type: "error", message: "boom", retryable: false });
  await flush();
  expect(wakes(h).map((w) => w.status)).toEqual(["failed", "failed"]);
  expect(h.store.steerMap.size).toBe(0);
});

test("a failed continuation deletes its rows instead of holding them", async () => {
  const h = await withContinuation();
  expect(wakes(h)).toHaveLength(2);
  h.runtime.last().emit({ type: "error", message: "boom", retryable: false });
  await flush();
  expect(wakes(h)).toHaveLength(2);
  expect(h.store.steerMap.size).toBe(0);
});

test("a failed continuation keeps rows bound to it but never claimed (new messages)", async () => {
  const h = await withContinuation();
  const cont = wakes(h).find((w) => w.text === CONTINUATION_PROMPT);
  if (!cont) throw new Error("no continuation");
  await h.store.steering.add(steer("late", 50, { wakeId: cont.id }));
  h.runtime.last().emit({ type: "error", message: "boom", retryable: false });
  await flush();
  // The claimed rows are gone; the late row went back to held and got its own continuation.
  expect([...h.store.steerMap.keys()]).toEqual(["late"]);
  expect(wakes(h).filter((w) => w.text === CONTINUATION_PROMPT)).toHaveLength(2);
});

test("a row pushed after the last tool result is unanswered: continuation run", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "start" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Bash", input: {} });
  s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "late one" });
  await flush();
  s.emit({ type: "tool_call", toolUseId: "t2", tool: "Bash", input: {} });
  await flush();
  expect(s.steered).toHaveLength(0);
  s.emit({ type: "tool_result", toolUseId: "t2", ok: true });
  await flush();
  expect(s.steered).toHaveLength(1);
  // The push followed the last tool result: nothing shows the model read it (a text answer is no proof).
  s.emit({ type: "text", text: "done" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(h.runtime.last().sent[0]?.text).toBe(`${CONTINUATION_PROMPT}\n\n${HEADER}\nlate one`);
});

test("a steer push that throws leaves the row unanswered", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "start" });
  await flush();
  const s = h.runtime.last();
  s.steer = () => {
    throw new Error("file gone");
  };
  h.surface.deliver({ conversationId: "dc", text: "more" });
  await flush();
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Bash", input: {} });
  s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
  s.emit({ type: "tool_call", toolUseId: "t2", tool: "Bash", input: {} });
  s.emit({ type: "tool_result", toolUseId: "t2", ok: true });
  s.emit({ type: "text", text: "done" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(h.runtime.last().sent[0]?.text).toBe(`${CONTINUATION_PROMPT}\n\n${HEADER}\nmore`);
});

test("a continuation a cap blocked is created at the next finish", async () => {
  const h = makeHub();
  const ctx = ctxOf(h);
  await h.store.steering.add(steer("later", 1));
  await h.store.spend.add("editor", new Date(0).toISOString().slice(0, 10), 999);
  await holdOrContinue(ctx, "editor", "ended1");
  expect(wakes(h).map((w) => w.status)).toEqual(["blocked"]);
  expect(h.log.of("run.continuation_not_created")).toHaveLength(1);
  expect(h.store.steerMap.get("later")?.wakeId).toBeUndefined();
  // The next day the cap is off; another run finishes in the scope.
  h.clock.advance(86_400_000);
  await holdOrContinue(ctx, "editor", "ended2");
  await flush();
  const cont = wakes(h).filter((w) => w.status !== "blocked");
  expect(cont).toHaveLength(1);
  expect(h.store.steerMap.get("later")?.wakeId).toBe(cont[0]?.id);
});
