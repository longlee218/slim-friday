import { expect, test } from "bun:test";
import type { WakeRow } from "../../src";
import { ownerWordsOf } from "../../src/permission/auto-review-step";
import { FakeStore } from "../fakes/fake-store";

/** The first wake of a chain; tests set the sender and the run fields. */
const first = (over: Partial<WakeRow>): WakeRow => ({
  id: "c1",
  chainId: "c1",
  conversationId: "bot:b1",
  targetBot: "b1",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: "the task",
  status: "running",
  attempts: 1,
  createdAt: 1,
  scopeKey: "b1",
  priority: "background",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  nudges: 0,
  ...over,
});

/** `ownerWordsAreOwner` of a chain whose first wake is `over`. */
async function areOwner(over: Partial<WakeRow>): Promise<boolean | undefined> {
  const store = new FakeStore();
  store.wakeMap.set("c1", first(over));
  return (await ownerWordsOf(store, "c1"))?.ownerWordsAreOwner;
}

test("a schedule chain's task counts as the owner's words (sender system)", async () => {
  expect(await areOwner({ sender: { kind: "system" }, scheduleId: "s1" })).toBe(true);
});

test("a system, bot or ticket chain without a schedule is not the owner's words", async () => {
  expect(await areOwner({ sender: { kind: "system" } })).toBe(false);
  expect(await areOwner({ sender: { kind: "bot", botId: "b2" } })).toBe(false);
  expect(await areOwner({ sender: { kind: "system" }, scheduleId: "s1", ticketId: "t1" })).toBe(
    false,
  );
});
