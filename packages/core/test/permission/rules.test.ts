import { expect, test } from "bun:test";
import type { Grant, PermissionSettings, ToolCall, ToolSpec } from "../../src";
import type { HubContext } from "../../src/hub/hub-context";
import { decide } from "../../src/permission/decide";
import { resolveRule } from "../../src/permission/match-grant";
import { PermissionGate } from "../../src/permission/permission-gate";
import { answerCard } from "../../src/runs/run-card-answer";
import { FakeClock } from "../fakes/fake-clock";
import { fakeRegistrableDomain as rd } from "../fakes/fake-registrable-domain";
import { FakeStore } from "../fakes/fake-store";
import { FakeSurface } from "../fakes/fake-surface";
import { FakeToolCatalog } from "../fakes/fake-tool-catalog";

const GMAIL_SEND = "mcp__gmail__send_email";
const FETCH: ToolSpec = {
  name: "WebFetch",
  annotations: { readOnlyHint: true, openWorldHint: true },
};
const WRITE: ToolSpec = { name: "T", annotations: { destructiveHint: false } };
const DELETE: ToolSpec = {
  name: "T",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
/** Destructive class but not irreversible (idempotent). */
const DESTRUCTIVE: ToolSpec = {
  name: "T",
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

const call = (tool: string, input: Record<string, unknown> = {}): ToolCall => ({
  botId: "b1",
  conversationId: "c1",
  tool,
  input,
});
const rule = (over: Partial<Grant>): Grant => ({
  id: "r",
  botId: "*",
  effect: "always_allow",
  match: "tool",
  tool: "T",
  scope: {},
  createdAt: 0,
  ...over,
});
const settings = (level: PermissionSettings["level"]): PermissionSettings => ({ level });
const run = (
  spec: ToolSpec | undefined,
  tool: string,
  grants: Grant[],
  level = "balanced" as const,
  site?: string,
) =>
  decide({
    call: call(tool),
    spec,
    grants,
    settings: settings(level),
    now: 1,
    ...(site && { site }),
  });

test("resolveRule: a site rule beats a tool rule", () => {
  const site = rule({ id: "s", match: "site", tool: "example.com", effect: "always_allow" });
  const tool = rule({ id: "t", tool: "WebFetch", effect: "require_approval" });
  expect(
    resolveRule([tool, site], call("WebFetch"), { site: "example.com", scope: {}, now: 1 })?.id,
  ).toBe("s");
  expect(
    resolveRule([tool, site], call("WebFetch"), { site: "other.org", scope: {}, now: 1 })?.id,
  ).toBe("t");
});

test("resolveRule: tool > server > category; a tie goes to require_approval", () => {
  const ctx = { server: "gmail", category: "email", scope: {}, now: 1 };
  const cat = rule({ id: "c", match: "category", tool: "email", effect: "require_approval" });
  const srv = rule({ id: "s", match: "server", tool: "gmail", effect: "always_allow" });
  const tool = rule({ id: "t", tool: GMAIL_SEND, effect: "require_approval" });
  expect(resolveRule([cat], call(GMAIL_SEND), ctx)?.id).toBe("c");
  expect(resolveRule([cat, srv], call(GMAIL_SEND), ctx)?.id).toBe("s");
  expect(resolveRule([cat, srv, tool], call(GMAIL_SEND), ctx)?.id).toBe("t");
  const allow = rule({ id: "a", tool: GMAIL_SEND, effect: "always_allow" });
  expect(resolveRule([allow, tool], call(GMAIL_SEND), ctx)?.effect).toBe("require_approval");
  expect(resolveRule([tool, allow], call(GMAIL_SEND), ctx)?.effect).toBe("require_approval");
});

test("resolveRule: other bots' rules, expired rules and unmatched scope never match", () => {
  const ctx = { scope: { repo: "a" }, now: 10 };
  expect(
    resolveRule([rule({ botId: "b2", scope: { repo: "a" } })], call("T"), ctx),
  ).toBeUndefined();
  expect(
    resolveRule([rule({ scope: { repo: "a" }, expiresAt: 10 })], call("T"), ctx),
  ).toBeUndefined();
  expect(resolveRule([rule({ scope: { repo: "b" } })], call("T"), ctx)).toBeUndefined();
  expect(resolveRule([rule({ scope: {} })], call("T"), ctx)).toBeUndefined();
  expect(resolveRule([rule({ scope: { repo: "*" } })], call("T"), ctx)).toBeDefined();
  // A site rule never matches a call with no site (a public-suffix host has none).
  expect(
    resolveRule([rule({ match: "site", tool: "fly.dev" })], call("WebFetch"), {
      scope: {},
      now: 1,
    }),
  ).toBeUndefined();
});

test("a category email require rule asks for gmail send even at autonomous", () => {
  const cat = rule({ match: "category", tool: "email", effect: "require_approval" });
  expect(run(undefined, GMAIL_SEND, [], "autonomous" as never).outcome).toBe("allow");
  expect(run(undefined, GMAIL_SEND, [cat], "autonomous" as never).outcome).toBe("ask");
  // A read of the same server has no category.
  expect(run(undefined, "mcp__gmail__list_emails", [cat], "autonomous" as never).outcome).toBe(
    "allow",
  );
});

test("require_approval asks even for a read class call", () => {
  const r = rule({ tool: "WebFetch", effect: "require_approval" });
  expect(run(FETCH, "WebFetch", [r], "autonomous" as never).outcome).toBe("ask");
});

test("always_allow allows an ask, but never an irreversible or mandatory call", () => {
  const allow = rule({});
  expect(run(WRITE, "T", [allow]).outcome).toBe("allow");
  expect(run(DELETE, "T", [allow])).toMatchObject({
    outcome: "ask_always",
    reason: "balanced: destructive; cannot be undone",
  });
  // Destructive but reversible (idempotent, not open-world): a rule allows it and its card offers "Always".
  expect(run(DESTRUCTIVE, "T", [allow], "autonomous" as never).outcome).toBe("allow");
  expect(run(DESTRUCTIVE, "T", [], "autonomous" as never)).toMatchObject({
    outcome: "ask",
    always: "tool",
  });
  const tainted = decide({
    call: call("T"),
    spec: WRITE,
    grants: [allow],
    settings: settings("autonomous"),
    now: 1,
    taint: { reason: "changes bot instructions", mandatory: true },
  });
  expect(tainted.outcome).toBe("ask_always");
});

test("an always_allow that cannot apply never hides a less specific require rule", () => {
  const spec: ToolSpec = { name: GMAIL_SEND, annotations: { openWorldHint: true } };
  const cat = rule({ id: "c", match: "category", tool: "email", effect: "require_approval" });
  expect(run(spec, GMAIL_SEND, [cat], "autonomous" as never).outcome).toBe("ask_always");
  const allow = rule({ id: "t", tool: GMAIL_SEND });
  expect(run(spec, GMAIL_SEND, [cat, allow], "autonomous" as never)).toMatchObject({
    outcome: "ask_always",
    reason: "rule c: require approval; cannot be undone",
  });
});

test("a scopeless require rule asks for a scoped tool; a scopeless allow rule does not allow it", () => {
  const push = "mcp__effects__GitPush";
  const spec: ToolSpec = {
    name: push,
    annotations: { destructiveHint: false, openWorldHint: true },
    scopeKeys: ["workspace", "branch"],
  };
  const c = (grants: Grant[], level: PermissionSettings["level"]) =>
    decide({
      call: call(push, { workspace: "w", branch: "b" }),
      spec,
      grants,
      settings: settings(level),
      now: 1,
    });
  expect(c([], "autonomous").outcome).toBe("allow");
  expect(c([rule({ tool: push, effect: "require_approval" })], "autonomous").outcome).toBe("ask");
  // A require rule that names a key still checks it.
  expect(
    c([rule({ tool: push, effect: "require_approval", scope: { branch: "main" } })], "autonomous")
      .outcome,
  ).toBe("allow");
  expect(c([rule({ tool: push })], "balanced").outcome).toBe("ask");
});

test("old style grants (always_allow + tool) still allow", () => {
  expect(run(WRITE, "T", [rule({ id: "g1" })]).reason).toBe("rule g1");
});

/** A gate over fakes at `balanced`, WebFetch in the catalog. */
function gateSetup() {
  const store = new FakeStore();
  const clock = new FakeClock(1000);
  const surface = new FakeSurface();
  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: new FakeToolCatalog([FETCH]),
    settings: () => ({ level: "balanced" as const }),
    registrableDomain: rd,
  });
  const hub = {
    deps: { store, clock, surface },
    hints: { cardAnswered() {} },
  } as unknown as HubContext;
  return { store, gate, hub };
}
const tainted = {
  wakeId: "w1",
  scopeKey: "b1",
  tainted: true,
  taint: {
    sites: new Set<string>(),
    approvedSites: new Set<string>(),
    usedMcpServers: new Set<string>(),
  },
};
const fetch = (url: string) => call("WebFetch", { url });

test("Always on a WebFetch card stores a site rule: b.example.com is allowed next, other.org asks", async () => {
  const { store, gate, hub } = gateSetup();
  const d = await gate.decide(fetch("https://a.example.com/x"), "B", tainted);
  expect(d.behavior).toBe("park");
  const card = [...store.cardMap.values()][0];
  expect(card?.approval?.offerAlways).toBe(true);
  expect(card?.approval?.always).toEqual({ match: "site", value: "example.com" });
  expect(await answerCard(hub, card?.id ?? "", "always")).toBe("ok");
  expect(store.grantList).toEqual([
    expect.objectContaining({
      botId: "b1",
      effect: "always_allow",
      match: "site",
      tool: "example.com",
      scope: {},
    }),
  ]);
  const next = { ...tainted, wakeId: "w2" };
  expect(await gate.decide(fetch("https://b.example.com/y"), "B", next)).toEqual({
    behavior: "allow",
  });
  expect((await gate.decide(fetch("https://other.org/z"), "B", next)).behavior).toBe("park");
});

test("no Always on a WebFetch card whose host has no registrable domain", async () => {
  const { store, gate } = gateSetup();
  expect((await gate.decide(fetch("https://fly.dev/x"), "B", tainted)).behavior).toBe("park");
  expect([...store.cardMap.values()][0]?.approval?.offerAlways).toBe(false);
});

test("a site require rule still asks in a tainted run, and its card offers no Always", async () => {
  const { store, gate } = gateSetup();
  await store.grants.add(rule({ match: "site", tool: "example.com", effect: "require_approval" }));
  expect((await gate.decide(fetch("https://a.example.com/x"), "B", tainted)).behavior).toBe("park");
  expect([...store.cardMap.values()][0]?.approval?.offerAlways).toBe(false);
  const clean = { ...tainted, wakeId: "w3", tainted: false };
  await store.cards.answer([...store.cardMap.keys()][0] ?? "", "deny", 1);
  expect((await gate.decide(fetch("https://a.example.com/x"), "B", clean)).behavior).toBe("park");
});

test("a tainted MCP first call yields to a server allow rule; a WebFetch taint ask never yields to a tool rule", async () => {
  const { store, gate } = gateSetup();
  await store.grants.add(rule({ id: "s", match: "server", tool: "ext", scope: {} }));
  await store.grants.add(rule({ id: "w", tool: "WebFetch", scope: {} }));
  expect(await gate.decide(call("mcp__ext__search_docs"), "B", tainted)).toEqual({
    behavior: "allow",
  });
  expect((await gate.decide(fetch("https://evil.test/x"), "B", tainted)).behavior).toBe("park");
});
