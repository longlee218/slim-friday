import { expect, test } from "bun:test";
import type { Author, WakeRow } from "../../src";
import type { HubContext } from "../../src/hub/hub-context";
import type { WakeOpts } from "../../src/hub/hub-types";
import { createRun } from "../../src/runs/run-create";
import { newRunExec } from "../../src/runs/run-exec";
import { NO_FINAL_ANSWER, NUDGE_TEXT, nudgeOrEnd } from "../../src/runs/run-nudge";
import { flush, makeHub } from "../bot-hub-harness";
import type { FakeSession } from "../fakes/fake-runtime";

type Hub = ReturnType<typeof makeHub>;
/** The hub's shared context (a test creates runs the way a worker would). */
const ctxOf = (h: Hub) => (h.hub as unknown as { ctx: HubContext }).ctx;
/** The only wake row of the test. */
const row = (h: Hub) => [...h.store.wakeMap.values()][0];
/** Texts the system posted (notices). */
const notices = (h: Hub) =>
  h.surface.posts.filter((p) => p.message.author.kind === "system").map((p) => p.message.text);

/** Start one run for editor in its direct chat: an owner message, or a run created with `opts`. */
async function start(h: Hub, sender?: Author, opts?: WakeOpts) {
  if (!sender) h.surface.deliver({ conversationId: "dc", text: "hi" });
  else
    await createRun(ctxOf(h), {
      botId: "editor",
      conversationId: "dc",
      sender,
      text: "x",
      hop: 1,
      opts,
    });
  await flush();
  return h.runtime.last();
}

/** One tool call and its result, then the turn ends with no text. */
async function silentToolTurn(s: FakeSession, id: string) {
  s.emit({ type: "tool_call", toolUseId: id, tool: "Read", input: { file_path: "/a" } });
  s.emit({ type: "tool_result", toolUseId: id, ok: true });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
}

test("a turn that ends right after a tool result is nudged 3 times, then the run fails", async () => {
  const h = makeHub();
  const s = await start(h);
  for (let n = 1; n <= 3; n++) {
    await silentToolTurn(s, `t${n}`);
    expect(s.sent).toHaveLength(n + 1);
    const nudge = s.sent[n];
    expect(nudge?.text).toBe(NUDGE_TEXT);
    expect(nudge?.automated).toBe(true);
    expect(nudge?.from).toEqual({ kind: "system" });
    expect(row(h)).toMatchObject({ status: "running", nudges: n });
  }
  await silentToolTurn(s, "t4");
  expect(s.sent).toHaveLength(4);
  expect(row(h)).toMatchObject({ status: "failed", error: NO_FINAL_ANSWER });
  expect(notices(h)).toContain(NO_FINAL_ANSWER);
});

test("a turn that ends with a background task open is not nudged and does not fail: the run waits", async () => {
  const h = makeHub();
  const s = await start(h);
  s.emit({ type: "tool_call", toolUseId: "a1", tool: "Agent", input: {} });
  s.emit({ type: "task_started", taskId: "k1", description: "dig" });
  s.emit({ type: "tool_result", toolUseId: "a1", ok: true });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(s.sent).toHaveLength(1);
  expect(row(h)).toMatchObject({ status: "running", nudges: 0 });
  s.emit({ type: "task_done", taskId: "k1", status: "completed", summary: "" });
  s.emit({ type: "text", text: "Found it." });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(s.sent).toHaveLength(1);
  expect(row(h)).toMatchObject({ status: "done", resultText: "Found it.", nudges: 0 });
});

test("a text after the tool result ends the run without a nudge", async () => {
  const h = makeHub();
  const s = await start(h);
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: {} });
  s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
  s.emit({ type: "text", text: "Done reading." });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(s.sent).toHaveLength(1);
  expect(row(h)).toMatchObject({ status: "done", nudges: 0 });
});

test("a nudged run that then answers is done with that answer", async () => {
  const h = makeHub();
  const s = await start(h);
  await silentToolTurn(s, "t1");
  s.emit({ type: "text", text: "Here you go." });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(row(h)).toMatchObject({ status: "done", resultText: "Here you go.", nudges: 1 });
});

test("a run that may stay silent (bot fyi, ticket) is not nudged: it ends silently after a tool result", async () => {
  for (const [sender, opts] of [
    [{ kind: "bot", botId: "writer" }, { intent: "fyi" }],
    [{ kind: "user" }, { ticketId: "FRI-1" }],
  ] as const) {
    const h = makeHub();
    const s = await start(h, sender, opts);
    await silentToolTurn(s, "t1");
    expect(s.sent).toHaveLength(1);
    expect(row(h)).toMatchObject({ status: "done", nudges: 0 });
  }
});

test("a resumed run keeps its nudge count from the row", async () => {
  const h = makeHub();
  const s = await start(h);
  const stored = row(h) as WakeRow;
  const scope = { key: "editor", bot: h.editor };
  // Two nudges used before the cut: one left.
  const two = newRunExec({ ...stored, nudges: 2 }, scope, 0, false);
  two.session = s;
  two.lastWasToolResult = true;
  expect(two.nudges).toBe(2);
  expect(await nudgeOrEnd(ctxOf(h), two)).toBe("nudged");
  expect(two.nudges).toBe(3);
  // All three used before the cut: the next silent tool end fails.
  const three = newRunExec({ ...stored, nudges: 3 }, scope, 0, false);
  three.session = s;
  three.lastWasToolResult = true;
  expect(await nudgeOrEnd(ctxOf(h), three)).toBe("fail");
  // No tool result last: done.
  const plain = newRunExec(stored, scope, 0, false);
  expect(await nudgeOrEnd(ctxOf(h), plain)).toBe("done");
});

test("a guard stop posts the guard text as the final answer and the run is done", async () => {
  const h = makeHub();
  const s = await start(h);
  s.emit({ type: "text", text: "Trying again." });
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: {} });
  s.emit({ type: "guard_stop", text: "I stopped after reaching the limit." });
  await flush();
  const posts = h.surface.posts.filter((p) => p.message.author.kind === "bot");
  expect(posts.map((p) => p.message.text)).toEqual(["I stopped after reaching the limit."]);
  expect(row(h)).toMatchObject({
    status: "done",
    resultText: "I stopped after reaching the limit.",
  });
  expect(s.stopped).toBe(true);
});

test("the tool-call cap reaches the runtime spec from the limits", async () => {
  const h = makeHub();
  const s = await start(h);
  expect(s.spec.maxToolCallsPerTurn).toBe(0);
});
