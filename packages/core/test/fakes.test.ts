import { expect, mock, test } from "bun:test";
import type { AgentRuntime, Clock, Store, StoredMessage, Surface, ToolCatalog } from "../src";
import { FakeClock } from "./fakes/fake-clock";
import { FakeFileStore } from "./fakes/fake-file-store";
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

test("FakeFileStore round trip and failNext", async () => {
  const files = new FakeFileStore();
  await files.put("k", new Uint8Array([1, 2, 3]), "image/png");
  expect(await files.stat("k")).toEqual({ size: 3, contentType: "image/png" });
  expect(Array.from(await files.readHead("k", 2))).toEqual([1, 2]);
  await files.delete("k");
  expect(await files.stat("k")).toBeUndefined();
  expect(files.deleted).toEqual(["k"]);
  expect(files.presignPut("k", 600, "image/png")).toBe("fake://put/k?exp=600&type=image/png");
  expect(files.presignGet("k", 900, { downloadName: "a.png" })).toBe(
    "fake://get/k?exp=900&dl=a.png",
  );
  files.failNext("stat");
  await expect(files.stat("k")).rejects.toThrow();
  expect(await files.stat("k")).toBeUndefined();
});

test("FakeFileStore failNext(read) rejects once, readHead keeps its own flag", async () => {
  const files = new FakeFileStore();
  await files.put("k", "abc", "text/plain");
  files.failNext("read");
  expect(await files.readHead("k", 1)).toEqual(new Uint8Array([97]));
  await expect(files.read("k")).rejects.toThrow();
  expect((await files.read("k")).length).toBe(3);
});

test("fake store: unread, reads never go back, and deleteLegacy", async () => {
  const s = new FakeStore();
  const add = (c: string, kind: "user" | "system") =>
    s.messages.append({ conversationId: c, author: { kind }, text: "t", at: 1 });
  await add("bot:a", "user");
  await add("bot:a", "system");
  await add("old1", "system");
  expect(
    await s.messages.append({
      conversationId: "bot:a",
      author: { kind: "user" },
      text: "t",
      at: 1,
    }),
  ).toBe(4);
  expect(await s.reads.unread("bot:a")).toBe(1);
  await s.reads.set("bot:a", 2);
  await s.reads.set("bot:a", 1);
  expect(await s.reads.get("bot:a")).toBe(2);
  expect(await s.reads.unread("bot:a")).toBe(0);
  s.convMap.set("old1", { id: "old1", kind: "direct", botId: "a" });
  s.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  expect(await s.conversations.deleteLegacy()).toBe(1);
  expect((await s.conversations.list()).map((c) => c.id)).toEqual(["bot:a"]);
  expect((await s.messages.page("bot:a", { limit: 10 })).map((m) => m.id)).toEqual([4, 2, 1]);
  expect(await s.messages.get(3)).toBeUndefined();
});
