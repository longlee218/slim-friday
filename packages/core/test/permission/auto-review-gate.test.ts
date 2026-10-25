import { expect, test } from "bun:test";
import type {
  AutoReviewer,
  Grant,
  PermissionSettings,
  ToolCall,
  ToolSpec,
  WakeRow,
} from "../../src";
import { decide } from "../../src/permission/decide";
import { PermissionGate } from "../../src/permission/permission-gate";
import { CONTINUATION_PROMPT } from "../../src/runs/run-steering";
import { FakeClock } from "../fakes/fake-clock";
import { FakeStore } from "../fakes/fake-store";
import { FakeSurface } from "../fakes/fake-surface";
import { FakeToolCatalog } from "../fakes/fake-tool-catalog";

/** Write class (balanced asks), reversible: the only kind of ask Auto Review sees. */
const PUSH: ToolSpec = {
  name: "Push",
  annotations: { destructiveHint: false, openWorldHint: true },
  scopeKeys: ["repo"],
};
/** Irreversible: `ask_always`. */
const DELETE: ToolSpec = {
  name: "Delete",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
const DESIGN: ToolSpec = {
  name: "mcp__design__BotDesign",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
const FETCH: ToolSpec = {
  name: "WebFetch",
  annotations: { readOnlyHint: true, openWorldHint: true },
};

type Review = Parameters<AutoReviewer["review"]>[0];

/** A reviewer that answers `answer` (or throws / hangs) and records what it saw. */
function reviewer(answer: "pass" | "ask" | "throw" | "hang", reason = "fits the task") {
  const seen: Review[] = [];
  const r: AutoReviewer = {
    review: async (i) => {
      seen.push(i);
      if (answer === "throw") throw new Error("boom");
      if (answer === "hang") return new Promise(() => {});
      return { decision: answer, reason };
    },
  };
  return { r, seen };
}

const ownerWake = (over: Partial<WakeRow> = {}): WakeRow => ({
  id: "chain1",
  chainId: "chain1",
  conversationId: "bot:b1",
  targetBot: "b1",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: "push my fix to repo a",
  status: "running",
  attempts: 1,
  createdAt: 1,
  scopeKey: "b1",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  nudges: 0,
  ...over,
});

function setup(
  r: AutoReviewer | undefined,
  autoReview: boolean,
  opts: { grants?: Grant[]; level?: PermissionSettings["level"]; timeoutMs?: number } = {},
) {
  const store = new FakeStore();
  const surface = new FakeSurface();
  const clock = new FakeClock(1000);
  for (const g of opts.grants ?? []) void store.grants.add(g);
  void store.wakes.insert(ownerWake());
  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: new FakeToolCatalog([PUSH, DELETE, DESIGN, FETCH]),
    settings: () => ({ level: opts.level ?? "balanced", autoReview }),
    ...(r && { autoReviewer: r }),
    ...(opts.timeoutMs !== undefined && { autoReviewTimeoutMs: opts.timeoutMs }),
  });
  return { store, surface, gate, clock };
}
const call = (tool: string, input: Record<string, unknown> = {}): ToolCall => ({
  botId: "b1",
  conversationId: "bot:b1",
  tool,
  input,
});
const ctx = (over: { chainId?: string; tainted?: boolean } = {}) => ({
  wakeId: "w1",
  scopeKey: "b1",
  tainted: false,
  chainId: "chain1",
  ...over,
});
const cardOf = (store: FakeStore) => [...store.cardMap.values()][0];

test("autoReview off: a plain ask is a card as today and the reviewer is never called", async () => {
  const { r, seen } = reviewer("pass");
  const { gate, store } = setup(r, false);
  expect((await gate.decide(call("Push", { repo: "a" }), "B", ctx())).behavior).toBe("park");
  expect(seen).toHaveLength(0);
  expect(cardOf(store)?.approval?.summary).toBe("Push repo=a");
});

test("on + pass: allowed, audited with the review, owner words are the chain's owner message", async () => {
  const { r, seen } = reviewer("pass", "the owner asked to push");
  const { gate, store, surface } = setup(r, true);
  expect(await gate.decide(call("Push", { repo: "a" }), "B", ctx())).toEqual({
    behavior: "allow",
  });
  expect(surface.shown).toHaveLength(0);
  expect(seen[0]).toEqual({
    ownerWords: "push my fix to repo a",
    ownerWordsAreOwner: true,
    tool: "Push",
    input: { repo: "a" },
  });
  expect(store.auditLog.at(-1)).toMatchObject({
    tool: "Push",
    outcome: "allow",
    review: { decision: "pass", reason: "the owner asked to push" },
  });
});

test("on + ask: the card's text starts with the reviewer's reason", async () => {
  const { r } = reviewer("ask", "Pushing is not what the owner asked.");
  const { gate, store } = setup(r, true);
  expect((await gate.decide(call("Push", { repo: "a" }), "B", ctx())).behavior).toBe("park");
  expect(cardOf(store)?.approval?.summary).toBe(
    "Auto Review: Pushing is not what the owner asked. | Push repo=a",
  );
  expect(store.auditLog.at(-1)).toMatchObject({ outcome: "ask", review: { decision: "ask" } });
});

test("reviewer throws: a card with the error as reason, never an allow", async () => {
  const { r } = reviewer("throw");
  const { gate, store } = setup(r, true);
  expect((await gate.decide(call("Push", { repo: "a" }), "B", ctx())).behavior).toBe("park");
  expect(store.auditLog.at(-1)?.review).toEqual({
    decision: "ask",
    reason: "Auto Review failed: boom",
  });
});

test("reviewer hangs: after the 10 s default a card, not before", async () => {
  const { r } = reviewer("hang");
  const { gate, store, clock } = setup(r, true);
  let done = false;
  const d = gate.decide(call("Push", { repo: "a" }), "B", ctx()).then((x) => {
    done = true;
    return x;
  });
  await Bun.sleep(5);
  clock.advance(9_999);
  await Bun.sleep(5);
  expect(done).toBe(false);
  clock.advance(1);
  expect((await d).behavior).toBe("park");
  expect(store.auditLog.at(-1)?.review).toEqual({
    decision: "ask",
    reason: "Auto Review timed out.",
  });
});

test("the timeout is injectable", async () => {
  const { r } = reviewer("hang");
  const { gate, clock } = setup(r, true, { timeoutMs: 50 });
  const d = gate.decide(call("Push", { repo: "a" }), "B", ctx());
  await Bun.sleep(5);
  clock.advance(50);
  expect((await d).behavior).toBe("park");
});

test("a reviewer answer of any other shape is an ask", async () => {
  const r: AutoReviewer = {
    review: async () => ({ decision: "allow" }) as unknown as { decision: "pass"; reason: string },
  };
  const { gate } = setup(r, true);
  expect((await gate.decide(call("Push", { repo: "a" }), "B", ctx())).behavior).toBe("park");
});

test("ask_always (irreversible, BotDesign), taint asks and require rules never reach the reviewer", async () => {
  const { r, seen } = reviewer("pass");
  const require: Grant = {
    id: "r1",
    botId: "*",
    effect: "require_approval",
    match: "tool",
    tool: "Push",
    scope: {},
    createdAt: 0,
  };
  const { gate } = setup(r, true);
  expect((await gate.decide(call("Delete"), "B", ctx())).behavior).toBe("park");
  const { gate: g2 } = setup(r, true);
  expect((await g2.decide(call("mcp__design__BotDesign"), "B", ctx())).behavior).toBe("park");
  const { gate: g3 } = setup(r, true);
  const fetch = call("WebFetch", { url: "https://evil.example/x" });
  expect((await g3.decide(fetch, "B", ctx({ tainted: true }))).behavior).toBe("park");
  const { gate: g5 } = setup(r, true, { grants: [require] });
  expect((await g5.decide(call("Push", { repo: "a" }), "B", ctx())).behavior).toBe("park");
  // Autonomous level: an irreversible call still asks always and is not reviewed.
  const { gate: g4 } = setup(r, true, { level: "autonomous" });
  expect((await g4.decide(call("Delete"), "B", ctx())).behavior).toBe("park");
  expect(seen).toHaveLength(0);
});

test("a tainted call is never reviewed: the card, the reviewer not called", async () => {
  const { r, seen } = reviewer("pass");
  const { gate, store } = setup(r, true);
  const d = await gate.decide(call("Push", { repo: "a" }), "B", ctx({ tainted: true }));
  expect(d.behavior).toBe("park");
  expect(seen).toHaveLength(0);
  expect(store.auditLog.at(-1)?.review).toBeUndefined();
});

test("a continuation run's fixed prompt is not the owner's words", async () => {
  const { r, seen } = reviewer("ask", "unclear");
  const { gate, store } = setup(r, true);
  await store.wakes.insert(
    ownerWake({ id: "c3", chainId: "c3", text: CONTINUATION_PROMPT, dedupeKey: "cont:w0" }),
  );
  await gate.decide(call("Push", { repo: "a" }), "B", ctx({ chainId: "c3" }));
  expect(seen[0]).toMatchObject({ ownerWords: CONTINUATION_PROMPT, ownerWordsAreOwner: false });
});

test("a run with no chain is not reviewed", async () => {
  const { r, seen } = reviewer("pass");
  const { gate } = setup(r, true);
  const noChain = { wakeId: "w1", scopeKey: "b1", tainted: false };
  expect((await gate.decide(call("Push", { repo: "a" }), "B", noChain)).behavior).toBe("park");
  expect(seen).toHaveLength(0);
});

test("a ticket chain is judged on the ticket text, marked as not the owner's words", async () => {
  const { r, seen } = reviewer("ask", "unclear");
  const { gate, store } = setup(r, true);
  const t = await store.tickets.create({
    title: "Fix login",
    description: "Push the fix to repo a",
    status: "todo",
    priority: "normal",
    createdBy: { kind: "bot", botId: "b2" },
    createdAt: 1,
  });
  await store.wakes.insert(
    ownerWake({ id: "c2", chainId: "c2", sender: { kind: "system" }, text: "x", ticketId: t.id }),
  );
  await gate.decide(call("Push", { repo: "a" }), "B", ctx({ chainId: "c2" }));
  expect(seen[0]?.ownerWordsAreOwner).toBe(false);
  expect(seen[0]?.ownerWords).toContain("Fix login");
  expect(seen[0]?.ownerWords).toContain("Push the fix to repo a");
});

test("decide: only the level's plain ask is reviewable; overrides, irreversible and taint asks are not", () => {
  const base = { call: call("Push"), grants: [], now: 1 };
  const level = { level: "balanced" as const };
  expect(decide({ ...base, spec: PUSH, settings: level }).reviewable).toBe(true);
  const override = { ...level, tools: { Push: "ask" as const } };
  expect(decide({ ...base, spec: PUSH, settings: override }).reviewable).toBeUndefined();
  const del = decide({ ...base, call: call("Delete"), spec: DELETE, settings: level });
  expect(del).toMatchObject({ outcome: "ask_always" });
  expect(del.reviewable).toBeUndefined();
  const taint = { reason: "x", mandatory: false };
  expect(decide({ ...base, spec: PUSH, settings: level, taint }).reviewable).toBeUndefined();
  expect(decide({ ...base, spec: undefined, settings: level }).reviewable).toBe(true);
});
