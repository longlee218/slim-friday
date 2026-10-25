import { expect, test } from "bun:test";
import type { Author, WakeRow } from "../../src";
import type { HubContext } from "../../src/hub/hub-context";
import type { WakeOpts } from "../../src/hub/hub-types";
import { createRun } from "../../src/runs/run-create";
import { flush, makeHub } from "../bot-hub-harness";

type Hub = ReturnType<typeof makeHub>;
/** The hub's shared context (a test creates runs the way a worker would). */
const ctxOf = (h: Hub) => (h.hub as unknown as { ctx: HubContext }).ctx;
/** The only stored run. */
const only = (h: Hub): WakeRow => {
  const [w] = [...h.store.wakeMap.values()];
  if (!w) throw new Error("no run stored");
  return w;
};
/** Texts the bot editor posted live in this attempt. */
const botPosts = (h: Hub) =>
  h.surface.posts
    .filter((p) => p.message.author.kind === "bot" && p.message.author.botId === "editor")
    .map((p) => p.message.text);

/** Start one run for editor in its direct chat (an owner message, or a run created with `opts`). */
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

/**
 * The answer an earlier attempt of the run already stored (it was cut after posting it), then a resumed turn
 * that ends with no text.
 */
async function resumedEmptyTurn(h: Hub, s: ReturnType<Hub["runtime"]["last"]>) {
  await h.store.messages.append({
    conversationId: "dc",
    author: { kind: "bot", botId: "editor" },
    text: "The real answer.",
    at: 1,
    wakeId: only(h).id,
  });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
}

test("an owner run whose answer was posted before a cut posts no done. after it; that answer is the result", async () => {
  const h = makeHub();
  const s = await start(h);
  await resumedEmptyTurn(h, s);
  expect(botPosts(h)).toEqual([]);
  expect(only(h)).toMatchObject({ status: "done", resultText: "The real answer." });
});

test("a delegated request run returns the answer it posted before a cut", async () => {
  const h = makeHub();
  const s = await start(h, { kind: "bot", botId: "writer" }, { intent: "request" });
  await resumedEmptyTurn(h, s);
  expect(botPosts(h)).not.toContain("done.");
  expect(only(h)).toMatchObject({ status: "done", resultText: "The real answer." });
});
