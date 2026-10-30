import { expect, test } from "bun:test";
import type { Memory, RuntimeEvent } from "../../src";
import { flush, makeHub } from "../bot-hub-harness";

/** A hub whose editor memory the test changes; `turnOf` runs one DM turn and returns what it sent. */
function memoryHub() {
  const texts = new Map<string, string>([["editor", "- codeword AMBER"]]);
  const memory: Memory = {
    read: async (o) => (o.kind === "bot" ? (texts.get(o.botId) ?? "") : ""),
    save: async () => {},
    edit: async () => {},
  };
  const h = makeHub(memory);
  let saves = 0;
  const stateSet = h.store.sessions.stateSet;
  h.store.sessions.stateSet = async (key, hashes) => {
    saves++;
    return stateSet(key, hashes);
  };
  /** Deliver `text`, emit `events` into the run's session, return the turn it got. */
  const turnOf = async (
    text: string,
    events: RuntimeEvent[] = [{ type: "turn_end", costUsd: 0 }],
  ) => {
    h.surface.deliver({ conversationId: "dc", text });
    await flush();
    const s = h.runtime.last();
    for (const e of events) s.emit(e);
    await flush();
    return s.sent[0];
  };
  return { ...h, texts, turnOf, saves: () => saves };
}

test("a run passes the resumed session's changed state into its turn, once", async () => {
  const { runtime, texts, turnOf } = memoryHub();
  expect((await turnOf("one"))?.stateChanged).toBeUndefined();
  texts.set("editor", "- codeword COBALT");
  const second = await turnOf("two");
  expect(runtime.resumed).toHaveLength(1);
  expect(second?.stateChanged).toContain("- codeword COBALT");
  expect((await turnOf("three"))?.stateChanged).toBeUndefined();
});

test("a run stopped before any event keeps the state block for the next open", async () => {
  const { hub, texts, turnOf } = memoryHub();
  await turnOf("one");
  texts.set("editor", "- codeword COBALT");
  expect((await turnOf("two", []))?.stateChanged).toContain("COBALT");
  await hub.stop("editor");
  await flush();
  expect((await turnOf("three"))?.stateChanged).toContain("COBALT");
});

test("a run whose first event is an error keeps the state block for the next open", async () => {
  const { texts, turnOf } = memoryHub();
  await turnOf("one");
  texts.set("editor", "- codeword COBALT");
  const failed = await turnOf("two", [{ type: "error", message: "cli died", retryable: false }]);
  expect(failed?.stateChanged).toContain("COBALT");
  expect((await turnOf("three"))?.stateChanged).toContain("COBALT");
});

test("the state is saved once, at the first model event; a stop after it sends no block again", async () => {
  const { hub, runtime, texts, turnOf, saves } = memoryHub();
  await turnOf("one");
  expect(saves()).toBe(1);
  texts.set("editor", "- codeword COBALT");
  await turnOf("two", []);
  expect(saves()).toBe(1); // sent, but no event yet: nothing saved
  const s = runtime.last();
  s.emit({ type: "thinking" });
  s.emit({ type: "text", text: "working" });
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: {} });
  await flush();
  expect(saves()).toBe(2);
  await hub.stop("editor");
  await flush();
  expect((await turnOf("three"))?.stateChanged).toBeUndefined();
  expect(saves()).toBe(3);
});
