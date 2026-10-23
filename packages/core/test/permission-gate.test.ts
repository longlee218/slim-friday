import { expect, test } from "bun:test";
import type { ToolCall, ToolSpec } from "../src";
import { PermissionGate } from "../src/permission/permission-gate";
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
    timeoutMs: 600_000,
  });
  return { store, surface, clock, gate };
}
const call = (tool: string, input: Record<string, unknown> = {}): ToolCall => ({
  botId: "b1",
  conversationId: "c1",
  tool,
  input,
});

test("allow needs no card and is audited", async () => {
  const { gate, surface, store } = setup();
  expect(await gate.decide(call("Read"), "Writer")).toEqual({ behavior: "allow" });
  expect(surface.approvals).toHaveLength(0);
  expect(store.auditLog).toHaveLength(1);
  expect(store.auditLog[0]).toMatchObject({ tool: "Read", outcome: "allow", botId: "b1" });
});

test("ask + always stores a grant; the same call is then allowed without a card", async () => {
  const { gate, surface, store } = setup();
  surface.answerWith("always");
  expect(await gate.decide(call("Push", { repo: "a" }), "Writer")).toEqual({ behavior: "allow" });
  expect(store.grantList).toHaveLength(1);
  expect(store.grantList[0]).toMatchObject({ botId: "b1", tool: "Push", scope: { repo: "a" } });
  expect(surface.approvals[0]?.card).toMatchObject({
    botName: "Writer",
    tool: "Push",
    offerAlways: true,
  });
  await gate.decide(call("Push", { repo: "a" }), "Writer");
  expect(surface.approvals).toHaveLength(1);
  surface.answerWith("deny");
  expect((await gate.decide(call("Push", { repo: "b" }), "Writer")).behavior).toBe("deny");
  expect(surface.approvals).toHaveLength(2);
});

test("once allows and stores nothing; the next call asks again", async () => {
  const { gate, surface, store } = setup();
  surface.answerWith("once");
  expect(await gate.decide(call("Push", { repo: "a" }), "W")).toEqual({ behavior: "allow" });
  expect(store.grantList).toHaveLength(0);
  await gate.decide(call("Push", { repo: "a" }), "W");
  expect(surface.approvals).toHaveLength(2);
});

test("deny answer denies with a reason", async () => {
  const { gate, surface } = setup();
  surface.answerWith("deny");
  expect(await gate.decide(call("Push"), "W")).toEqual({
    behavior: "deny",
    reason: "denied by the user",
  });
});

test("an irreversible call is asked without Always allow, and a forged 'always' stores nothing", async () => {
  const { gate, surface, store } = setup();
  surface.answerWith("always");
  const d = await gate.decide(call("Delete"), "W");
  expect(surface.approvals[0]?.card.offerAlways).toBe(false);
  expect(d).toEqual({ behavior: "allow" });
  expect(store.grantList).toHaveLength(0);
});

test("no answer in time is a deny and stores no grant", async () => {
  const { gate, surface, store, clock } = setup();
  surface.answerWith("never");
  const pending = gate.decide(call("Push"), "W");
  await new Promise((r) => setTimeout(r, 0)); // let the gate reach its wait
  clock.advance(600_000);
  expect(await pending).toEqual({ behavior: "deny", reason: "approval timed out" });
  expect(store.grantList).toHaveLength(0);
  expect(store.auditLog[0]?.reason).toContain("timed out");
});

test("every asked call writes one audit entry with the outcome and the answer", async () => {
  const { gate, surface, store } = setup();
  surface.answerWith("once");
  await gate.decide(call("Push", { repo: "a" }), "W");
  expect(store.auditLog).toHaveLength(1);
  expect(store.auditLog[0]).toMatchObject({ outcome: "ask", answer: "once" });
});
