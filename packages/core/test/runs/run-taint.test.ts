import { expect, test } from "bun:test";
import type { WakeRow } from "../../src";
import { flush, makeHub } from "../bot-hub-harness";

const EXT = "mcp__ext__search";
type Hub = ReturnType<typeof makeHub>;

/** A hub whose catalog knows WebFetch and an external read-only MCP tool (balanced allows both). */
function hub(): Hub {
  const h = makeHub();
  h.catalog.tools = [
    { name: "WebFetch", annotations: { readOnlyHint: true, openWorldHint: true } },
    { name: EXT, annotations: { readOnlyHint: true } },
  ];
  return h;
}
/** The only stored run. */
const only = (h: Hub): WakeRow => {
  const [w] = [...h.store.wakeMap.values()];
  if (!w) throw new Error("no run stored");
  return w;
};
const fetch = (url: string) => ({ tool: "WebFetch", input: { url } });

/** Start an owner run with `text`, then let tool `tool` run and return in its session. */
async function ownerRunAfter(h: Hub, text: string, tool?: string) {
  h.surface.deliver({ conversationId: "dc", text });
  await flush();
  const s = h.runtime.last();
  if (tool) {
    s.emit({ type: "tool_call", toolUseId: "t1", tool, input: {} });
    s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
    await flush();
  }
  return s;
}

test("an owner-started run is clean until Read returns, then tainted and stored", async () => {
  const h = hub();
  h.surface.deliver({ conversationId: "dc", text: "summarise the notes" });
  await flush();
  const s = h.runtime.last();
  expect(await s.spec.decide(fetch("https://other.test/a"))).toEqual({ behavior: "allow" });
  s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: { file_path: "/x" } });
  await flush();
  // The call is open, its result not read yet: still clean.
  expect(only(h).tainted).toBeUndefined();
  s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
  await flush();
  expect(only(h).tainted).toBe(true);
  expect((await s.spec.decide(fetch("https://other.test/a"))).behavior).toBe("park");
});

test("MemorySearch does not taint the run", async () => {
  const h = hub();
  const s = await ownerRunAfter(h, "what did I say", "mcp__memory__MemorySearch");
  expect(only(h).tainted).toBeUndefined();
  expect(await s.spec.decide(fetch("https://other.test/a"))).toEqual({ behavior: "allow" });
});

test("tainted: a fetch to a site in the owner's message needs no card, another site does", async () => {
  const h = hub();
  const s = await ownerRunAfter(h, "check https://docs.example.com/page", "Read");
  expect(await s.spec.decide(fetch("https://example.com/other"))).toEqual({ behavior: "allow" });
  expect((await s.spec.decide(fetch("https://evil.test/x"))).behavior).toBe("park");
  expect([...h.store.cardMap.values()][0]?.approval?.summary).toContain("evil.test");
});

test("tainted: first external MCP call asks; after approval the second one does not", async () => {
  const h = hub();
  const s = await ownerRunAfter(h, "search for me", "Read");
  const first = { tool: EXT, input: { q: "a" } };
  const d = await s.spec.decide(first);
  expect(d.behavior).toBe("park");
  await flush();
  await h.hub.answerCard(d.behavior === "park" ? d.cardId : "", "once");
  await flush();
  const r = h.runtime.last();
  expect(r).not.toBe(s);
  expect(await r.spec.decide(first)).toEqual({ behavior: "allow" });
  expect(await r.spec.decide({ tool: EXT, input: { q: "b" } })).toEqual({ behavior: "allow" });
  expect(h.store.cardMap.size).toBe(1);
});

test("a subagent's call is decided as tainted even in a clean run", async () => {
  const h = hub();
  const s = await ownerRunAfter(h, "go");
  const d = await s.spec.decide({ ...fetch("https://other.test/a"), taskId: "agent-1" });
  expect(d.behavior).toBe("park");
});

test("a resume keeps the stored taint", async () => {
  const h = hub();
  await h.store.wakes.insert({
    id: "w1",
    chainId: "w1",
    conversationId: "dc",
    targetBot: "editor",
    sender: { kind: "user" },
    intent: "request",
    hop: 0,
    text: "carry on",
    status: "queued",
    attempts: 0,
    createdAt: 0,
    scopeKey: "editor",
    priority: "interactive",
    leaseFence: 0,
    tainted: true,
    cuts: 0,
    transientRetries: 0,
    setupFailures: 0,
    nudges: 0,
  });
  await h.hub.recover();
  await flush();
  const s = h.runtime.last();
  expect(only(h)).toMatchObject({ status: "running", leaseFence: 1, tainted: true });
  expect((await s.spec.decide(fetch("https://other.test/a"))).behavior).toBe("park");
});
