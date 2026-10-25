import { expect, test } from "bun:test";
import type { ToolCall, ToolSpec } from "../../src";
import { PermissionGate } from "../../src/permission/permission-gate";
import {
  noteTaintAllowed,
  type TaintRun,
  taintAsk,
  taints,
} from "../../src/permission/taint-policy";
import { FakeClock } from "../fakes/fake-clock";
import { FakeStore } from "../fakes/fake-store";
import { FakeSurface } from "../fakes/fake-surface";
import { FakeToolCatalog } from "../fakes/fake-tool-catalog";

const BOT_DESIGN = "mcp__design__BotDesign";
const EXT = "mcp__ext__search";
const UPDATE_PROFILE = "mcp__chat__UpdateProfile";
const RO = { readOnlyHint: true };
const SPECS: ToolSpec[] = [
  { name: "WebFetch", annotations: { readOnlyHint: true, openWorldHint: true } },
  // Without irreversible hints, so a grant would allow it.
  { name: BOT_DESIGN, annotations: { destructiveHint: false, openWorldHint: false } },
  { name: EXT, annotations: RO },
  { name: UPDATE_PROFILE, annotations: RO },
];

/** A run state; tainted unless said otherwise. */
const run = (over: Partial<TaintRun> = {}): TaintRun => ({
  tainted: true,
  sites: new Set(["example.com"]),
  approvedSites: new Set(),
  usedMcpServers: new Set(),
  ...over,
});
const call = (tool: string, input: Record<string, unknown> = {}): ToolCall => ({
  botId: "b1",
  conversationId: "c1",
  tool,
  input,
});
const fetch = (url: string) => call("WebFetch", { url });

test("own-state tools never taint; anything else does", () => {
  expect(taints("Read")).toBe(true);
  expect(taints("WebFetch")).toBe(true);
  expect(taints("Bash")).toBe(true);
  expect(taints(EXT)).toBe(true);
  expect(taints("mcp__memory__MemorySearch")).toBe(false);
  expect(taints("mcp__scratchpad__ScratchpadList")).toBe(false);
  expect(taints("mcp__tickets__TicketGet")).toBe(false);
  expect(taints("mcp__memory__MessageSearch")).toBe(false);
  expect(taints("mcp__chat__PostUpdate")).toBe(false);
  expect(taints("AskUserQuestion")).toBe(false);
});

test("a clean run never gets a taint ask", () => {
  const clean = run({ tainted: false });
  expect(taintAsk(fetch("https://evil.test/x"), clean)).toBeUndefined();
  expect(taintAsk(call(BOT_DESIGN), clean)).toBeUndefined();
  expect(taintAsk(call(EXT), clean)).toBeUndefined();
});

test("tainted: sites the owner named or approved pass, others ask", () => {
  expect(taintAsk(fetch("https://docs.example.com/a"), run())).toBeUndefined();
  expect(taintAsk(fetch("https://evil.test/x"), run())).toContain("evil.test");
  expect(taintAsk(fetch("not a url"), run())).toBeDefined();
  const r = run();
  noteTaintAllowed(fetch("https://www.evil.test/y"), r);
  expect(taintAsk(fetch("https://evil.test/x"), r)).toBeUndefined();
});

test("tainted: instruction changes and the first external MCP call ask; Friday tools do not", () => {
  expect(taintAsk(call(BOT_DESIGN), run())).toBeDefined();
  const r = run();
  expect(taintAsk(call(EXT), r)).toContain("ext");
  noteTaintAllowed(call(EXT), r);
  expect(taintAsk(call(EXT, { q: "other" }), r)).toBeUndefined();
  expect(taintAsk(call(UPDATE_PROFILE), run())).toBeUndefined();
  expect(taintAsk(call("mcp__memory__MemorySave"), run())).toBeUndefined();
  expect(taintAsk(call("Bash"), run())).toBeUndefined();
});

/** A gate over fakes at `autonomous`, with a grant for BotDesign and WebFetch's level allowing reads. */
function gateSetup() {
  const store = new FakeStore();
  const gate = new PermissionGate({
    store,
    surface: new FakeSurface(),
    clock: new FakeClock(1000),
    catalog: new FakeToolCatalog(SPECS),
    settings: () => ({ level: "autonomous" }),
  });
  return { store, gate };
}
const ctx = (r: TaintRun) => ({
  wakeId: "w1",
  scopeKey: "b1",
  tainted: r.tainted,
  taint: r,
});

test("gate: a tainted fetch to an owner site is allowed, to another site parks with the reason", async () => {
  const { gate, store } = gateSetup();
  expect(await gate.decide(fetch("https://example.com/a"), "B", ctx(run()))).toEqual({
    behavior: "allow",
  });
  const d = await gate.decide(fetch("https://evil.test/a"), "B", ctx(run()));
  expect(d.behavior).toBe("park");
  const card = [...store.cardMap.values()][0];
  expect(card?.approval?.offerAlways).toBe(false);
  expect(card?.approval?.summary).toContain("evil.test was not named by the owner");
});

test("gate: tainted BotDesign asks even with a grant; clean it is allowed by the grant", async () => {
  const { gate, store } = gateSetup();
  await store.grants.add({ id: "g1", botId: "b1", tool: BOT_DESIGN, scope: {}, createdAt: 0 });
  const clean = run({ tainted: false });
  expect(await gate.decide(call(BOT_DESIGN), "B", ctx(clean))).toEqual({ behavior: "allow" });
  expect((await gate.decide(call(BOT_DESIGN), "B", ctx(run()))).behavior).toBe("park");
});

test("gate: a grant still allows a tainted external MCP call", async () => {
  const { gate, store } = gateSetup();
  expect((await gate.decide(call(EXT), "B", ctx(run()))).behavior).toBe("park");
  const { gate: g2, store: s2 } = gateSetup();
  await s2.grants.add({ id: "g1", botId: "b1", tool: EXT, scope: {}, createdAt: 0 });
  expect(await g2.decide(call(EXT), "B", ctx(run()))).toEqual({ behavior: "allow" });
  expect(store.cardMap.size).toBe(1);
});

test("gate: a tainted UpdateProfile gets no card", async () => {
  const { gate, store } = gateSetup();
  expect(await gate.decide(call(UPDATE_PROFILE), "B", ctx(run()))).toEqual({ behavior: "allow" });
  expect(store.cardMap.size).toBe(0);
});
