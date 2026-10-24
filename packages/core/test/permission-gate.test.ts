import { expect, test } from "bun:test";
import type { ToolCall, ToolSpec } from "../src";
import { inputHash } from "../src/permission/input-hash";
import { PermissionGate, WAITING_TEXT } from "../src/permission/permission-gate";
import { FakeClock } from "./fakes/fake-clock";
import { FakeStore } from "./fakes/fake-store";
import { FakeSurface } from "./fakes/fake-surface";
import { FakeToolCatalog } from "./fakes/fake-tool-catalog";

const PUSH: ToolSpec = {
  name: "Push",
  annotations: { destructiveHint: false, openWorldHint: true },
  scopeKeys: ["repo"],
};
const DELETE: ToolSpec = {
  name: "Delete",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
const READ: ToolSpec = { name: "Read", annotations: { readOnlyHint: true } };

function setup() {
  const store = new FakeStore();
  const surface = new FakeSurface();
  const clock = new FakeClock(1000);
  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: new FakeToolCatalog([PUSH, DELETE, READ]),
    settings: () => ({ level: "balanced" }),
  });
  return { store, surface, clock, gate };
}
const call = (tool: string, input: Record<string, unknown> = {}): ToolCall => ({
  botId: "b1",
  conversationId: "c1",
  tool,
  input,
});
/** The run context of run `w1` in scope `b1`. */
const run = (over: { wakeId?: string; oneShot?: string } = {}) => ({
  wakeId: "w1",
  scopeKey: "b1",
  tainted: false,
  ...over,
});

test("allow needs no card and is audited", async () => {
  const { gate, surface, store } = setup();
  expect(await gate.decide(call("Read"), "Writer", run())).toEqual({ behavior: "allow" });
  expect(surface.shown).toHaveLength(0);
  expect(store.auditLog).toHaveLength(1);
  expect(store.auditLog[0]).toMatchObject({ tool: "Read", outcome: "allow", botId: "b1" });
});

test("ask writes one stored card with the exact call and parks", async () => {
  const { gate, surface, store } = setup();
  const d = await gate.decide(call("Push", { repo: "a" }), "Writer", run());
  expect(d.behavior).toBe("park");
  const cardId = d.behavior === "park" ? d.cardId : "";
  const card = store.cardMap.get(cardId);
  expect(card).toMatchObject({
    kind: "approval",
    wakeId: "w1",
    scopeKey: "b1",
    conversationId: "c1",
    status: "open",
    approval: { tool: "Push", input: { repo: "a" }, summary: "Push repo=a", offerAlways: true },
  });
  expect(card?.approval?.inputHash).toBe(await inputHash("Push", { repo: "a" }));
  expect(surface.shown.map((s) => [s.card.id, s.botName])).toEqual([[cardId, "Writer"]]);
  expect(store.auditLog[0]).toMatchObject({ outcome: "ask" });
});

test("second ask in the same step does not open a second card", async () => {
  const { gate, store } = setup();
  await gate.decide(call("Push", { repo: "a" }), "W", run());
  expect(await gate.decide(call("Push", { repo: "b" }), "W", run())).toEqual({
    behavior: "deny",
    reason: WAITING_TEXT,
  });
  expect(store.cardMap.size).toBe(1);
  // Another run of the scope (a new owner message) gets its own card.
  expect(
    (await gate.decide(call("Push", { repo: "b" }), "W", run({ wakeId: "w2" }))).behavior,
  ).toBe("park");
});

test("the approved call is allowed by its one shot; a different input asks again", async () => {
  const { gate, store } = setup();
  const hash = await inputHash("Push", { repo: "a" });
  expect(await gate.decide(call("Push", { repo: "a" }), "W", run({ oneShot: hash }))).toEqual({
    behavior: "allow",
  });
  expect(store.cardMap.size).toBe(0);
  const other = await gate.decide(call("Push", { repo: "b" }), "W", run({ oneShot: hash }));
  expect(other.behavior).toBe("park");
});

test("the input hash ignores key order", async () => {
  expect(await inputHash("T", { a: 1, b: { c: 2, d: 3 } })).toBe(
    await inputHash("T", { b: { d: 3, c: 2 }, a: 1 }),
  );
  expect(await inputHash("T", { a: 1 })).not.toBe(await inputHash("U", { a: 1 }));
});

test("no Always allow for an irreversible call, a '*' scope or an unknown tool", async () => {
  const { gate, store } = setup();
  await gate.decide(call("Delete"), "W", run({ wakeId: "a" }));
  await gate.decide(call("Push", { repo: "*" }), "W", run({ wakeId: "b" }));
  await gate.decide(call("Mystery"), "W", run({ wakeId: "c" }));
  expect([...store.cardMap.values()].map((c) => c.approval?.offerAlways)).toEqual([
    false,
    false,
    false,
  ]);
});

test("a failing store denies instead of throwing; a failing surface still parks on the stored card", async () => {
  const { gate, store } = setup();
  store.grants.list = async () => {
    throw new Error("db down");
  };
  expect((await gate.decide(call("Read"), "W", run())).behavior).toBe("deny");
  const s2 = setup();
  s2.surface.showCard = () => {
    throw new Error("surface down");
  };
  expect((await s2.gate.decide(call("Push", { repo: "a" }), "W", run())).behavior).toBe("park");
  expect(s2.store.cardMap.size).toBe(1);
});
