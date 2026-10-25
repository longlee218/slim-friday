import { expect, test } from "bun:test";
import type { SteeringRow, WakeRow } from "../../src";
import type { HubContext } from "../../src/hub/hub-context";
import { newRunExec } from "../../src/runs/run-exec";
import { nudgeOrEnd } from "../../src/runs/run-nudge";
import { CONTINUATION_PROMPT } from "../../src/runs/run-steering";
import { flush, makeHub } from "../bot-hub-harness";

type Hub = ReturnType<typeof makeHub>;
/** The hub's shared context. */
const ctxOf = (h: Hub) => (h.hub as unknown as { ctx: HubContext }).ctx;
/** Texts editor posted. */
const botPosts = (h: Hub) =>
  h.surface.posts.filter((p) => p.message.author.kind === "bot").map((p) => p.message.text);

/** A queued run row in editor's direct scope. */
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

/** A steering row bound to run w1. */
const steer = (id: string): SteeringRow => ({
  id,
  messageId: 1,
  conversationId: "dc",
  scopeKey: "editor",
  text: id,
  createdAt: 1,
  wakeId: "w1",
});

test("steering pushed after the last tool result: a silent turn end is done, no nudge; one answer after the continuation", async () => {
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
  // Pushed at the last tool result; nothing after it shows the model read it.
  s.emit({ type: "tool_result", toolUseId: "t2", ok: true });
  await flush();
  expect(s.steered).toHaveLength(1);
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  // No nudge into the first session: the continuation run carries the message.
  expect(s.sent).toHaveLength(1);
  const cont = h.runtime.last();
  expect(cont).not.toBe(s);
  expect(cont.sent).toHaveLength(1);
  expect(cont.sent[0]?.text).toStartWith(CONTINUATION_PROMPT);
  cont.emit({ type: "text", text: "Answer to late one." });
  cont.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(botPosts(h).filter((t) => t === "Answer to late one.")).toHaveLength(1);
  expect(h.runtime.created).toHaveLength(2);
});

test("a guard stop answers the first turn's steering rows: no continuation run re-sends them", async () => {
  const h = makeHub();
  await h.store.wakes.insert(run());
  await h.store.steering.add(steer("two"));
  await h.hub.recover();
  await flush();
  const s = h.runtime.last();
  expect(s.sent[0]?.text).toContain("two");
  s.emit({ type: "guard_stop", text: "Stopped by the guard." });
  await flush();
  expect(h.store.wakeMap.get("w1")?.status).toBe("done");
  expect(h.store.steerMap.size).toBe(0);
  expect(h.runtime.created).toHaveLength(1);
});

test("a lost lease at the nudge sends nothing", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const s = h.runtime.last();
  const stored = [...h.store.wakeMap.values()][0] as WakeRow;
  // The row's fence moved on: another worker owns the run.
  const exec = newRunExec(
    { ...stored, leaseFence: stored.leaseFence - 1 },
    { key: "editor", bot: h.editor },
    0,
    false,
  );
  exec.session = s;
  exec.lastWasToolResult = true;
  expect(await nudgeOrEnd(ctxOf(h), exec)).toBe("done");
  expect(s.sent).toHaveLength(1);
  expect(exec.nudges).toBe(0);
});
