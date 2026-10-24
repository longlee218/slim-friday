import { expect, test } from "bun:test";
import { postStored } from "../src";
import { FakeStore } from "./fakes/fake-store";
import { FakeSurface } from "./fakes/fake-surface";

const m = { conversationId: "dc", author: { kind: "system" as const }, text: "hi", at: 1 };

test("postStored appends first, posts the row with its id, returns the id", async () => {
  const store = new FakeStore();
  const surface = new FakeSurface();
  const id = await postStored({ store, surface }, m);
  expect(store.msgs[id - 1]).toMatchObject({ text: "hi" });
  expect(surface.posts[0]?.message).toMatchObject({ id, text: "hi" });
});

test("a failing post rejects and the row stays in the store", async () => {
  const store = new FakeStore();
  const surface = new FakeSurface();
  surface.post = async () => {
    throw new Error("down");
  };
  await expect(postStored({ store, surface }, m)).rejects.toThrow("down");
  expect(store.msgs).toHaveLength(1);
  expect(store.msgs[0]).toMatchObject({ text: "hi" });
});
