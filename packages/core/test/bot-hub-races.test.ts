import { describe, expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

/** `<bot>/<text>:<status>` of every stored wake. */
const states = (store: {
  wakeMap: Map<string, { targetBot: string; text: string; status: string }>;
}) => [...store.wakeMap.values()].map((w) => `${w.targetBot}/${w.text.slice(0, 12)}:${w.status}`);

describe("hub races", () => {
  test("two messages that arrive together to an idle bot: one runs, one waits", async () => {
    const { runtime, surface, store } = makeHub();
    surface.deliver({ conversationId: "dc", text: "one" });
    surface.deliver({ conversationId: "dc", text: "two" });
    await flush();
    expect(runtime.nth(0).sent.length).toBe(1);
    expect(states(store).filter((s) => s.endsWith(":running")).length).toBe(1);
  });

  test("a message that arrives while the turn end is handled waits; the finished wake is done", async () => {
    const { runtime, surface, store, hub } = makeHub();
    surface.deliver({ conversationId: "gc", text: "go" });
    await flush();
    await hub.send("writer", { to: "editor", text: "do x", intent: "request" } as never);
    await flush();
    const ed = runtime.nth(1);
    ed.emit({ type: "text", text: "x done" });
    await flush();
    ed.emit({ type: "turn_end", costUsd: 0 });
    surface.deliver({ conversationId: "dc", text: "hi editor" });
    await flush();
    const s = states(store);
    expect(s).toContain("editor/do x:done");
    expect(s).toContain("editor/hi editor:running");
    expect(ed.sent.length).toBe(2);
  });
});
