import { expect, test } from "bun:test";
import type { Author } from "../../src";
import type { HubContext } from "../../src/hub/hub-context";
import type { WakeOpts } from "../../src/hub/hub-types";
import { createRun } from "../../src/runs/run-create";
import { abortRun } from "../../src/runs/run-exec";
import { flush, makeHub } from "../bot-hub-harness";

type Hub = ReturnType<typeof makeHub>;
/** The hub's shared context (a test creates runs the way a worker would). */
const ctxOf = (h: Hub) => (h.hub as unknown as { ctx: HubContext }).ctx;
/** Texts posted by the bot editor. */
const botPosts = (h: Hub) =>
  h.surface.posts
    .filter((p) => p.message.author.kind === "bot" && p.message.author.botId === "editor")
    .map((p) => p.message.text);
const writer: Author = { kind: "bot", botId: "writer" };

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

/** Run one turn of `text` events, then end it. */
async function turn(h: Hub, texts: string[]) {
  const s = await start(h);
  for (const text of texts) s.emit({ type: "text", text });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
}

test("narration (text then a tool call) is a run step, not a message; the last answer text is the final", async () => {
  const h = makeHub();
  const s = await start(h);
  s.emit({ type: "text", text: "Let me look at the files." });
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: { file_path: "/a" } });
  await flush();
  expect(botPosts(h)).toEqual([]);
  const shown = h.surface.runs.map((r) => r.step);
  expect(shown.some((st) => st.target === "Let me look at the files.")).toBe(true);
  s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
  s.emit({ type: "text", text: "Here it is." });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(botPosts(h)).toEqual(["Here it is."]);
  expect([...h.store.wakeMap.values()][0]).toMatchObject({
    status: "done",
    resultText: "Here it is.",
  });
});

test("two texts in a row are both answers", async () => {
  const h = makeHub();
  await turn(h, ["one", "two"]);
  expect(botPosts(h)).toEqual(["one", "two"]);
});

test("NO_RESPONSE on a ticket run posts nothing", async () => {
  const h = makeHub();
  const s = await start(h, { kind: "user" }, { ticketId: "FRI-1" });
  s.emit({ type: "text", text: "NO_RESPONSE" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(botPosts(h)).toEqual([]);
});

test("an empty final of a ticket run posts nothing at all", async () => {
  const h = makeHub();
  const s = await start(h, { kind: "user" }, { ticketId: "FRI-1" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(botPosts(h)).toEqual([]);
  expect(h.surface.posts).toEqual([]);
});

test("a bot fyi that answers no request may stay silent; an empty final posts nothing", async () => {
  const h = makeHub();
  const s = await start(h, writer, { intent: "fyi" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(botPosts(h)).toEqual([]);
});

test("NO_RESPONSE on an owner run posts done.", async () => {
  const h = makeHub();
  await turn(h, ["NO_RESPONSE"]);
  expect(botPosts(h)).toEqual(["done."]);
});

test("prose with a trailing sentinel posts the prose", async () => {
  const h = makeHub();
  await turn(h, ["All set.\nNO_RESPONSE"]);
  expect(botPosts(h)).toEqual(["All set."]);
});

test("an empty owner final posts done.", async () => {
  const h = makeHub();
  await turn(h, []);
  expect(botPosts(h)).toEqual(["done."]);
});

test("an empty owner final posts nothing more when progress notes were posted in the run", async () => {
  const h = makeHub();
  const s = await start(h);
  const wakeId = [...h.store.wakeMap.values()][0]?.id;
  await h.store.messages.append({
    conversationId: "dc",
    author: { kind: "bot", botId: "editor" },
    text: "halfway",
    at: 0,
    kind: "progress",
    ...(wakeId && { wakeId }),
  });
  s.emit({ type: "text", text: "Checking." });
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: {} });
  s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(botPosts(h)).toEqual([]);
});

test("a bot result run with NO_RESPONSE posts done.", async () => {
  const h = makeHub();
  const s = await start(h, writer, { intent: "result" });
  s.emit({ type: "text", text: "NO_RESPONSE" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(botPosts(h)).toEqual(["done."]);
});

test("a bot request run with NO_RESPONSE posts done. and returns no result", async () => {
  const h = makeHub();
  const s = await start(h, writer, { intent: "request" });
  s.emit({ type: "text", text: "NO_RESPONSE" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(botPosts(h)).toEqual(["done."]);
  expect([...h.store.wakeMap.values()][0]?.resultText).toBeUndefined();
});

test("a silent follow-up turn keeps the earlier prose answer: no done., the prose is the result", async () => {
  const h = makeHub();
  const s = await start(h, writer, { intent: "request" });
  s.emit({ type: "text", text: "Here is the plan." });
  s.emit({ type: "task_started", taskId: "k1", description: "dig" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  s.emit({ type: "task_done", taskId: "k1", status: "completed", summary: "" });
  s.emit({ type: "text", text: "NO_RESPONSE" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(botPosts(h)).toEqual(["Here is the plan."]);
  expect([...h.store.wakeMap.values()][0]).toMatchObject({
    status: "done",
    resultText: "Here is the plan.",
  });
});

test("the owner's Stop posts a text still held as the answer", async () => {
  const h = makeHub();
  const s = await start(h);
  s.emit({ type: "text", text: "Partial answer." });
  await flush();
  expect(botPosts(h)).toEqual([]);
  await h.hub.stop("editor");
  await flush();
  expect(botPosts(h)).toEqual(["Partial answer."]);
  expect([...h.store.wakeMap.values()][0]?.status).toBe("cancelled");
});

test("a lost lease drops a text still held", async () => {
  const h = makeHub();
  const s = await start(h);
  s.emit({ type: "text", text: "Partial answer." });
  await flush();
  const exec = [...ctxOf(h).runs.values()][0];
  if (exec) abortRun(exec, { kind: "lease", why: "renew" });
  await flush();
  expect(botPosts(h)).toEqual([]);
});

test("an owner final raises one finished notice: 180-char preview, newlines collapsed", async () => {
  const h = makeHub();
  const long = `line one\nline two ${"x".repeat(300)}`;
  await turn(h, [long]);
  expect(h.surface.finished).toHaveLength(1);
  const f = h.surface.finished[0];
  expect(f).toMatchObject({ conversationId: "dc", botId: "editor" });
  expect([...(f?.preview ?? "")]).toHaveLength(180);
  expect(f?.preview.startsWith("line one line two ")).toBe(true);
  expect(f?.preview.endsWith("…")).toBe(true);
});

test("an empty owner final posts done. and notices it", async () => {
  const h = makeHub();
  await turn(h, []);
  expect(botPosts(h)).toEqual(["done."]);
  expect(h.surface.finished.map((f) => f.preview)).toEqual(["done."]);
});

test("ticket, intro and bot-to-bot runs raise no finished notice; a silent owner-less run neither", async () => {
  for (const [sender, opts] of [
    [{ kind: "user" }, { ticketId: "FRI-1" }],
    [{ kind: "system" }, { intro: true }],
    [writer, undefined],
  ] as const) {
    const h = makeHub();
    const s = await start(h, sender, opts);
    s.emit({ type: "text", text: "All good." });
    s.emit({ type: "turn_end", costUsd: 0 });
    await flush();
    expect(h.surface.finished).toEqual([]);
  }
});

test("a progress message raises no finished notice; the final raises exactly one", async () => {
  const h = makeHub();
  const s = await start(h);
  h.clock.advance(61_000);
  s.emit({ type: "text", text: "Still working on it." });
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: { file_path: "/a" } });
  await flush();
  expect(botPosts(h)).toEqual(["Still working on it."]);
  expect(h.surface.finished).toEqual([]);
  s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
  s.emit({ type: "text", text: "All done." });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(h.surface.finished.map((f) => f.preview)).toEqual(["All done."]);
});
