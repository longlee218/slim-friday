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

test("cut run: answered rows deleted, unanswered offered again", async () => {
  const h = makeHub();
  await h.store.wakes.insert(
    run({
      status: "running",
      attempts: 1,
      startedAt: 0,
      leaseOwner: "oldboot:main",
      leaseFence: 1,
      leaseExpiresAt: 300_000,
      firstTextAt: 50,
    }),
  );
  await h.store.steering.add(steer("answered", 1, { wakeId: "w1", claimedAt: 40 }));
  await h.store.steering.add(steer("unanswered", 2, { wakeId: "w1", claimedAt: 60 }));
  await h.store.steering.add(steer("fresh", 3, { wakeId: "w1" }));
  await h.hub.recover();
  await flush();
  expect(h.store.steerMap.has("answered")).toBe(false);
  const text = h.runtime.last().sent[0]?.text ?? "";
  expect(text).toContain(`${HEADER}\nunanswered`);
  expect(text).toContain(`${HEADER}\nfresh`);
  expect(text).not.toContain(`${HEADER}\nanswered`);
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

test("rows bound to a run that fails go back to held without a continuation", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "start" });
  await flush();
  h.surface.deliver({ conversationId: "dc", text: "more" });
  await flush();
  h.runtime.last().emit({ type: "error", message: "boom", retryable: false });
  await flush();
  expect(wakes(h)[0]?.status).toBe("failed");
  expect(wakes(h)).toHaveLength(1);
  expect([...h.store.steerMap.values()].map((r) => [r.text, r.wakeId])).toEqual([
    ["more", undefined],
  ]);
});
