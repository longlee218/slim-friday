import { expect, mock, test } from "bun:test";
import type { AgentRuntime, Clock, Store, StoredMessage, Surface, ToolCatalog } from "../src";
import { FakeClock } from "./fakes/fake-clock";
import { FakeRuntime } from "./fakes/fake-runtime";
import { FakeStore } from "./fakes/fake-store";
import { FakeSurface } from "./fakes/fake-surface";
import { FakeToolCatalog } from "./fakes/fake-tool-catalog";

test("fakes implement the ports", async () => {
  const store: Store = new FakeStore();
  const runtime: AgentRuntime = new FakeRuntime();
  const surface: Surface = new FakeSurface();
  const clock: Clock = new FakeClock(0);
  const catalog: ToolCatalog = new FakeToolCatalog([]);
  expect([runtime, surface, catalog].length).toBe(3);

  const m: StoredMessage = { conversationId: "c1", author: { kind: "user" }, text: "hi", at: 1 };
  await store.messages.append(m);
  expect(await store.messages.recent("c1", 5)).toEqual([m]);

  const fn = mock(() => {});
  clock.setTimer(10, fn);
  (clock as FakeClock).advance(10);
  expect(fn).toHaveBeenCalledTimes(1);
});
