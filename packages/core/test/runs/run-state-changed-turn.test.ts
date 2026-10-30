import { expect, test } from "bun:test";
import type { Memory } from "../../src";
import { flush, makeHub } from "../bot-hub-harness";

test("a run passes the resumed session's changed state into its turn, once", async () => {
  const texts = new Map<string, string>([["editor", "- codeword AMBER"]]);
  const memory: Memory = {
    read: async (o) => (o.kind === "bot" ? (texts.get(o.botId) ?? "") : ""),
    save: async () => {},
    edit: async () => {},
  };
  const { runtime, surface } = makeHub(memory);
  const turnOf = async (text: string) => {
    surface.deliver({ conversationId: "dc", text });
    await flush();
    const s = runtime.last();
    s.emit({ type: "turn_end", costUsd: 0 });
    await flush();
    return s.sent[0];
  };
  expect((await turnOf("one"))?.stateChanged).toBeUndefined();
  texts.set("editor", "- codeword COBALT");
  const second = await turnOf("two");
  expect(runtime.resumed).toHaveLength(1);
  expect(second?.stateChanged).toContain("- codeword COBALT");
  expect((await turnOf("three"))?.stateChanged).toBeUndefined();
});
