import { expect, test } from "bun:test";
import { FakeStore } from "./fakes/fake-store";

test("FakeStore page with before 0 returns nothing", async () => {
  const s = new FakeStore();
  await s.messages.append({ conversationId: "bot:a", author: { kind: "user" }, text: "hi", at: 1 });
  expect(await s.messages.page("bot:a", { before: 0, limit: 10 })).toEqual([]);
});
